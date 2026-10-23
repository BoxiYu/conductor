// The orchestrator owns all scheduling state: which issues are claimed, running or waiting to
// retry. Workers report back here; nothing else mutates this state. Modeled on the Symphony spec
// (poll -> reconcile -> dispatch, exponential backoff, tracker-driven recovery, no database).

import { statSync } from "node:fs";
import type { AgentEvent, Config, Issue, TurnResult, Usage, Workflow } from "./types.ts";
import type { PullRequestRef, Tracker } from "./tracker/tracker.ts";
import { MARKER, norm } from "./tracker/tracker.ts";
import { Router } from "./router.ts";
import { applySandbox, sandboxEnv } from "./sandbox.ts";
import { runTurn as defaultRunTurn, type RunTurnOptions } from "./agents/runner.ts";
import { loadWorkflow, renderPrompt, validateForDispatch } from "./workflow.ts";
import {
  REPORT_FILE,
  afterRun,
  agentEnv,
  branchName,
  clearHandoff,
  clearReport,
  finalizeCommits,
  prepareWorkspace,
  pushBranch,
  readHandoff,
  readReport,
  readSession,
  removeWorkspace,
  workspacePath,
  writeHandoff,
  writeSession,
} from "./workspace.ts";
import { log } from "./log.ts";
import { Telemetry } from "./telemetry.ts";

export { MARKER };

export function protocolFooter(verifyCommands: string[] = []): string {
  const verify = verifyCommands.length
    ? `\n- Verify your work by running: ${verifyCommands.map((c) => `\`${c}\``).join(", ")}. Fix failures you caused. If a command is not permitted in this environment, say so in your summary; that alone is not a reason to report "blocked".`
    : "";
  return `

---
Conductor protocol (always applies):
- You are running unattended. Nobody will answer questions; make reasonable decisions and keep going.
- Work only inside the current directory. Commit your work with clear messages on the current branch if you can. If committing is not permitted, leave the changes in the working tree: Conductor commits them for you, so never report "blocked" just because you cannot commit.
- Do not push and do not open pull requests: Conductor does that after you finish.${verify}
- When the task is complete, write \`${REPORT_FILE}\` containing JSON: {"status":"done","summary":"<what you changed and how you verified it>","pr_title":"<short PR title>"}.
- If you cannot proceed because something outside your control is missing (access, secrets, unclear requirements), write {"status":"blocked","summary":"<what is missing and what a human must do>"} to the same file.
- Until that file exists, Conductor will keep asking you to continue.`;
}

export function continuationPrompt(turn: number, maxTurns: number, denied: string | null = null, allowed: string[] = []): string {
  const note = denied
    ? `\n\nYour previous turn stopped because this was not permitted here: ${denied}. Do not retry it. ` +
      (allowed.length ? `Shell commands you may run (one per call, no \`&&\`, \`;\` or pipes): ${allowed.map((c) => `\`${c}\``).join(", ")}. ` : "") +
      `Use your file read/edit tools for everything else. Uncommitted changes are fine: Conductor commits them.`
    : "";
  return `Continue working on the same task (turn ${turn} of ${maxTurns}). Pick up from the current state of the workspace. When finished, write ${REPORT_FILE} as described earlier; if blocked, write it with status "blocked".${note}`;
}

/** Symphony backoff: 10s * 2^(attempt-1), capped. */
export function backoffMs(attempt: number, maxMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxMs);
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  const pr = (p: number | null) => (p !== null && p >= 1 && p <= 4 ? p : 99);
  return [...issues].sort(
    (a, b) =>
      pr(a.priority) - pr(b.priority) ||
      (a.createdAt ?? "￿").localeCompare(b.createdAt ?? "￿") ||
      a.identifier.localeCompare(b.identifier),
  );
}

export function isRoutable(issue: Issue, config: Config): boolean {
  const have = issue.labels.map(norm);
  return config.tracker.requiredLabels.every((l) => l.trim() !== "" && have.includes(norm(l)));
}

export const isActive = (issue: Issue, c: Config) =>
  c.tracker.activeStates.map(norm).includes(norm(issue.state)) && !isTerminal(issue, c);
export const isTerminal = (issue: Issue, c: Config) => c.tracker.terminalStates.map(norm).includes(norm(issue.state));

interface RunEntry {
  issue: Issue;
  agent: string;
  attempt: number;
  startedAt: number;
  lastEventAt: number;
  turn: number;
  sessionId: string | null;
  usage: Usage;
  lastText: string;
  abort: AbortController;
  stopReason: "terminal" | "inactive" | "shutdown" | null;
  phase: "preparing" | "running" | "handing off";
  branch: string | null;
  prUrl: string | null;
  lastTool: { name: string; detail: string | null; at: number } | null;
  toolCalls: number;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: number;
  error: string;
  exclude: string[];
  timer: ReturnType<typeof setTimeout>;
}

type WorkerOutcome =
  | { kind: "handoff"; status: "done" | "blocked"; prUrl: string | null }
  | { kind: "inactive" }
  | { kind: "exhausted" }
  | { kind: "failed"; error: string; rateLimited: boolean };

export interface OrchestratorDeps {
  tracker: Tracker;
  runTurn?: (opts: RunTurnOptions) => Promise<TurnResult>;
  now?: () => number;
}

export class Orchestrator {
  workflow: Workflow;
  private workflowMtime = 0;
  readonly router: Router;
  readonly telemetry: Telemetry;
  private readonly bootedAt: number;
  readonly running = new Map<string, RunEntry>();
  readonly claimed = new Set<string>();
  readonly retries = new Map<string, RetryEntry>();
  totals = { inputTokens: 0, outputTokens: 0, runs: 0, handoffs: 0, failures: 0 };
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly tracker: Tracker;
  private readonly runTurnImpl: (opts: RunTurnOptions) => Promise<TurnResult>;
  private readonly now: () => number;
  /** Resolves when a worker finishes; handy for tests and graceful shutdown. */
  readonly workerPromises = new Map<string, Promise<void>>();

  constructor(workflow: Workflow, deps: OrchestratorDeps) {
    this.workflow = workflow;
    this.tracker = deps.tracker;
    this.runTurnImpl = deps.runTurn ?? defaultRunTurn;
    this.now = deps.now ?? Date.now;
    this.router = new Router(workflow.config);
    this.telemetry = new Telemetry(this.now);
    this.bootedAt = this.now();
    try {
      this.workflowMtime = statSync(workflow.path).mtimeMs;
    } catch {}
  }

  get config(): Config {
    return this.workflow.config;
  }

  // ---------- lifecycle ----------

  async start() {
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  async stop() {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    for (const entry of this.running.values()) {
      entry.stopReason = "shutdown";
      entry.abort.abort();
    }
    await Promise.allSettled(this.workerPromises.values());
  }

  /** Wait until nothing is running and no retry is queued (used by --once). */
  async drain() {
    const busy = () => this.running.size > 0 || this.retries.size > 0 || this.firingRetries > 0;
    while (busy()) {
      await Promise.allSettled(this.workerPromises.values());
      if (this.running.size === 0 && busy()) await Bun.sleep(200);
    }
  }

  private scheduleTick(delay: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(async () => {
      await this.tick();
      this.scheduleTick(this.config.polling.intervalMs);
    }, delay);
  }

  /** Run one tick now (used by the HTTP refresh endpoint and --once). Concurrent calls coalesce. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.doTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private maybeReloadWorkflow() {
    let mtime = 0;
    try {
      mtime = statSync(this.workflow.path).mtimeMs;
    } catch {
      return;
    }
    if (mtime === this.workflowMtime) return;
    try {
      const next = loadWorkflow(this.workflow.path);
      if (next.config.tracker.kind !== this.config.tracker.kind || next.config.tracker.repo !== this.config.tracker.repo) {
        log("warn", "workflow_reload_tracker_change_ignored", { note: "tracker changes need a restart" });
        next.config.tracker = this.config.tracker;
      }
      this.workflow = next;
      this.router.updateConfig(next.config);
      log("info", "workflow_reloaded", { path: next.path });
    } catch (err) {
      log("error", "workflow_reload_failed", { error: (err as Error).message });
    }
    this.workflowMtime = mtime;
  }

  private async startupCleanup() {
    try {
      const terminal = await this.tracker.fetchTerminal();
      for (const issue of terminal) await removeWorkspace(this.config, issue.identifier).catch(() => undefined);
    } catch (err) {
      log("warn", "startup_cleanup_failed", { error: (err as Error).message });
    }
  }

  private async doTick() {
    this.maybeReloadWorkflow();
    await this.reconcile();
    const problems = validateForDispatch(this.config);
    if (problems.length) {
      log("error", "dispatch_preflight_failed", { problems });
      return;
    }
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidates();
    } catch (err) {
      log("error", "fetch_candidates_failed", { error: (err as Error).message });
      return;
    }
    for (const issue of sortForDispatch(candidates)) {
      if (this.availableSlots() <= 0) break;
      if (!this.eligible(issue)) continue;
      if (await this.heldForReview(issue)) continue;
      this.dispatch(issue, null, []);
    }
  }

  /**
   * An issue Conductor handed off is active again. Pick it up only if a human commented or
   * reviewed after the hand-off (a rework request). Otherwise an automation moved it (e.g.
   * Linear's "PR opened → In Progress"): leave it, and move it back to the hand-off state once.
   */
  private async heldForReview(issue: Issue): Promise<boolean> {
    let path: string;
    try {
      path = workspacePath(this.config.workspace.root, issue.identifier);
    } catch {
      return false;
    }
    const handoff = readHandoff(path);
    if (!handoff) return false;
    const pr = await this.tracker.findPullRequest(issue, branchName(this.config, issue)).catch(() => null);
    const latest = await this.tracker.latestHumanActivity(issue, pr).catch(() => null);
    if (latest && Date.parse(latest) > Date.parse(handoff.at)) return false;
    if (!handoff.reapplied && norm(issue.state) !== norm(handoff.state)) {
      log("warn", "handoff_state_restored", {
        issue: issue.identifier,
        found: issue.state,
        restored: handoff.state,
        hint: "an automation moved a handed-off issue back to an active state; to request rework, comment or review first",
      });
      await this.tracker.setState(issue, handoff.state).catch((err) => log("warn", "set_state_failed", { error: (err as Error).message }));
      this.telemetry.event("restored", issue, null, `moved back to ${handoff.state} (was ${issue.state} without new feedback)`);
      writeHandoff(path, { ...handoff, reapplied: true });
    }
    return true;
  }

  private availableSlots() {
    return Math.max(this.config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private eligible(issue: Issue): boolean {
    return (
      Boolean(issue.id && issue.identifier && issue.title && issue.state) &&
      isActive(issue, this.config) &&
      isRoutable(issue, this.config) &&
      !this.running.has(issue.id) &&
      !this.claimed.has(issue.id)
    );
  }

  private routerView() {
    return {
      running: (agent: string) => [...this.running.values()].filter((r) => r.agent === agent).length,
      now: this.now,
    };
  }

  // ---------- reconciliation ----------

  private async reconcile() {
    if (this.running.size === 0) return;
    let fresh: Issue[];
    try {
      fresh = await this.tracker.fetchByIds([...this.running.keys()]);
    } catch (err) {
      log("warn", "reconcile_refresh_failed", { error: (err as Error).message });
      return;
    }
    const byId = new Map(fresh.map((i) => [i.id, i]));
    for (const [id, entry] of this.running) {
      const issue = byId.get(id);
      if (!issue || isTerminal(issue, this.config)) {
        this.stopRun(entry, "terminal");
      } else if (!isActive(issue, this.config) || !isRoutable(issue, this.config)) {
        this.stopRun(entry, "inactive");
      } else {
        entry.issue = { ...issue };
      }
    }
  }

  private stopRun(entry: RunEntry, reason: "terminal" | "inactive") {
    if (entry.stopReason) return;
    log("info", "run_stopped_by_reconciliation", { issue: entry.issue.identifier, reason });
    this.telemetry.event("stopped", entry.issue, entry.agent, `stopped: issue is ${reason === "terminal" ? "closed" : "no longer active"}`);
    entry.stopReason = reason;
    entry.abort.abort();
  }

  // ---------- dispatch ----------

  private dispatch(issue: Issue, attempt: number | null, exclude: string[]): boolean {
    const previous = this.previousAgent(issue);
    const agent = this.router.pick(issue, this.routerView(), previous, exclude);
    if (!agent) {
      log("debug", "no_agent_available", { issue: issue.identifier, exclude });
      if (attempt !== null) this.scheduleRetry(issue, attempt, "no available agent", exclude, 30_000);
      return false;
    }
    const entry: RunEntry = {
      issue: { ...issue },
      agent,
      attempt: attempt ?? 0,
      startedAt: this.now(),
      lastEventAt: this.now(),
      turn: 0,
      sessionId: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      lastText: "",
      abort: new AbortController(),
      stopReason: null,
      phase: "preparing",
      branch: null,
      prUrl: null,
      lastTool: null,
      toolCalls: 0,
    };
    this.claimed.add(issue.id);
    this.running.set(issue.id, entry);
    this.totals.runs++;
    log("info", "dispatched", { issue: issue.identifier, agent, attempt, state: issue.state });
    this.telemetry.agent(agent).runs++;
    this.telemetry.event("dispatched", issue, agent, attempt ? `attempt ${attempt + 1}: ${issue.title}` : issue.title);
    const p = this.runWorker(entry)
      .catch((err): WorkerOutcome => ({ kind: "failed", error: (err as Error).message, rateLimited: false }))
      .then((outcome) => this.onWorkerExit(entry, outcome, exclude))
      .finally(() => this.workerPromises.delete(issue.id));
    this.workerPromises.set(issue.id, p);
    return true;
  }

  private previousAgent(issue: Issue): string | null {
    try {
      return readSession(workspacePath(this.config.workspace.root, issue.identifier))?.agent ?? null;
    } catch {
      return null;
    }
  }

  private async runWorker(entry: RunEntry): Promise<WorkerOutcome> {
    const config = this.config;
    const { issue, agent } = entry;
    const agentCfg = config.agents[agent]!;

    if (norm(issue.state) === norm(config.tracker.defaultState)) {
      await this.tracker.setState(issue, config.tracker.inProgressState);
      await this.tracker
        .comment(issue, `${MARKER}\n🤖 Conductor picked this up with **${agent}**.`)
        .catch((err) => log("warn", "comment_failed", { error: (err as Error).message }));
    }

    const ws = await prepareWorkspace(config, issue);
    clearHandoff(ws.path);
    try {
      const session = readSession(ws.path);
      let sessionId = session && session.agent === agent ? session.sessionId : null;
      const pr = ws.isGit ? await this.tracker.findPullRequest(issue, ws.branch).catch(() => null) : null;
      entry.branch = ws.isGit ? ws.branch : null;
      entry.prUrl = pr?.url ?? null;
      entry.phase = "running";
      const feedback = pr || norm(issue.state) === "rework" ? await this.tracker.fetchFeedback(issue, pr).catch(() => "") : "";
      clearReport(ws.path);
      const env = { ...agentEnv(config), ...sandboxEnv(config, ws.path) };
      let denied: string | null = null;

      for (let turn = 1; turn <= config.agent.maxTurns; turn++) {
        entry.turn = turn;
        // Recomputed every turn so per-workspace sandbox files are rewritten before launch.
        const turnAgent = applySandbox(agentCfg, config, ws.path);
        const prompt =
          turn === 1
            ? (await renderPrompt(this.workflow.promptTemplate, {
                issue: issue as unknown as Record<string, unknown>,
                attempt: entry.attempt || null,
                agent,
                feedback,
              })) + protocolFooter(config.verify.commands)
            : continuationPrompt(turn, config.agent.maxTurns, denied, turnAgent.allowedCommands);

        const result = await this.runTurnImpl({
          agent: turnAgent,
          prompt,
          sessionId,
          cwd: ws.path,
          env,
          turnTimeoutMs: config.agent.turnTimeoutMs,
          stallTimeoutMs: config.agent.stallTimeoutMs,
          signal: entry.abort.signal,
          onEvent: (e) => this.onAgentEvent(entry, e),
        });
        this.addUsage(entry, result.usage);
        if (result.sessionId) {
          sessionId = result.sessionId;
          entry.sessionId = sessionId;
          writeSession(ws.path, { agent, sessionId, updatedAt: new Date().toISOString() });
        }
        if (entry.stopReason) return { kind: "inactive" };
        denied = result.permissionDenied;
        if (denied) {
          log("warn", "agent_permission_denied", { issue: issue.identifier, agent, turn, denied });
          this.telemetry.event("denied", issue, agent, `turn ${turn}: not permitted: ${denied}`);
        }
        // A refused tool call ends some CLIs' turns (grok cancels); resume the session instead of failing.
        if (!result.ok && denied && turn < config.agent.maxTurns) continue;
        if (!result.ok) {
          log("warn", "turn_failed", { issue: issue.identifier, agent, turn, reason: result.reason, error: result.error?.slice(0, 500) });
          this.telemetry.event("turn_failed", issue, agent, `turn ${turn} ${result.reason}: ${result.error ?? ""}`);
          return { kind: "failed", error: result.error ?? result.reason, rateLimited: result.rateLimited };
        }
        log("info", "turn_completed", { issue: issue.identifier, agent, turn, usage: result.usage });
        this.telemetry.event(
          "turn",
          issue,
          agent,
          `turn ${turn} done · ${result.usage.inputTokens}/${result.usage.outputTokens} tokens${result.finalText ? ` · ${result.finalText.slice(0, 160)}` : ""}`,
        );

        const report = readReport(ws.path);
        if (report) return await this.handoff(entry, ws, report, pr);

        const [fresh] = await this.tracker.fetchByIds([issue.id]).catch(() => [issue]);
        if (!fresh || !isActive(fresh, config) || !isRoutable(fresh, config)) return { kind: "inactive" };
        entry.issue = { ...fresh };
      }
      return { kind: "exhausted" };
    } finally {
      await afterRun(config, ws.path).catch(() => undefined);
    }
  }

  private async handoff(
    entry: RunEntry,
    ws: { path: string; branch: string; isGit: boolean },
    report: { status: "done" | "blocked"; summary: string; prTitle?: string },
    existingPr: PullRequestRef | null,
  ): Promise<WorkerOutcome> {
    const config = this.config;
    const { issue, agent } = entry;
    let pr = existingPr;
    entry.phase = "handing off";

    if (ws.isGit && config.handoff.openPullRequest) {
      const { ahead } = await finalizeCommits(ws.path, issue);
      if (ahead > 0) {
        await pushBranch(ws.path, ws.branch);
        if (!pr) {
          pr = await this.tracker.openPullRequest({
            issue,
            branch: ws.branch,
            title: report.prTitle || `${issue.title} (#${issue.number})`,
            body: `${this.tracker.closingReference(issue)}\n\n${report.summary}\n\n---\n${MARKER}\n_Implemented by **${agent}** via Conductor._`,
            draft: config.handoff.draft || report.status === "blocked",
          });
        }
      }
    }

    const icon = report.status === "done" ? "✅" : "⛔";
    const lines = [
      MARKER,
      `${icon} **${agent}** finished with status \`${report.status}\`.`,
      pr ? `PR: ${pr.url}` : "",
      "",
      report.summary,
      "",
      `<sub>turns: ${entry.turn} · tokens in/out: ${entry.usage.inputTokens}/${entry.usage.outputTokens}</sub>`,
    ];
    await this.tracker.comment(issue, lines.filter((l, i) => l !== "" || i > 2).join("\n")).catch(() => undefined);
    await this.tracker.setState(issue, report.status === "done" ? config.tracker.reviewState : config.tracker.blockedState);
    writeHandoff(ws.path, {
      at: new Date().toISOString(),
      state: report.status === "done" ? config.tracker.reviewState : config.tracker.blockedState,
      reapplied: false,
    });
    this.totals.handoffs++;
    entry.prUrl = pr?.url ?? null;
    this.telemetry.agent(agent).handoffs++;
    this.telemetry.event("handoff", issue, agent, `${report.status}: ${report.summary.slice(0, 200)}`, pr?.url ?? null);
    log("info", "handoff", { issue: issue.identifier, agent, status: report.status, pr: pr?.url });
    return { kind: "handoff", status: report.status, prUrl: pr?.url ?? null };
  }

  private onAgentEvent(entry: RunEntry, e: AgentEvent) {
    entry.lastEventAt = this.now();
    if (e.type === "text") entry.lastText = e.text.slice(0, 500);
    if (e.type === "session") entry.sessionId = e.sessionId;
    if (e.type === "tool") {
      log("debug", "agent_tool", { issue: entry.issue.identifier, agent: entry.agent, tool: e.name, detail: e.detail });
      entry.lastTool = { name: e.name, detail: e.detail ?? null, at: this.now() };
      entry.toolCalls++;
      this.telemetry.agent(entry.agent).toolCalls++;
    }
    if (e.type === "rate_limit") {
      log("warn", "agent_rate_limit", { agent: entry.agent, message: e.message });
      this.telemetry.event("rate_limit", entry.issue, entry.agent, e.message);
    }
    this.telemetry.version++;
  }

  private addUsage(entry: RunEntry, u: Usage) {
    entry.usage.inputTokens += u.inputTokens;
    entry.usage.outputTokens += u.outputTokens;
    const stats = this.telemetry.agent(entry.agent);
    stats.inputTokens += u.inputTokens;
    stats.outputTokens += u.outputTokens;
    this.totals.inputTokens += u.inputTokens;
    this.totals.outputTokens += u.outputTokens;
  }

  // ---------- worker exit + retries ----------

  private async onWorkerExit(entry: RunEntry, outcome: WorkerOutcome, previousExclude: string[]) {
    const { issue } = entry;
    this.running.delete(issue.id);
    log("info", "worker_exited", { issue: issue.identifier, agent: entry.agent, outcome: outcome.kind, stop: entry.stopReason });
    this.telemetry.finish({
      issue: issue.identifier,
      title: issue.title,
      issueUrl: issue.url,
      agent: entry.agent,
      outcome: entry.stopReason ? "stopped" : outcome.kind,
      status: outcome.kind === "handoff" ? outcome.status : null,
      error: outcome.kind === "failed" ? outcome.error.slice(0, 300) : entry.stopReason ? `stopped: ${entry.stopReason}` : null,
      prUrl: outcome.kind === "handoff" ? outcome.prUrl : entry.prUrl,
      attempt: entry.attempt,
      turns: entry.turn,
      usage: { ...entry.usage },
      startedAt: entry.startedAt,
      endedAt: this.now(),
    });
    if (outcome.kind === "failed" && !outcome.rateLimited && !entry.stopReason) this.telemetry.agent(entry.agent).failures++;

    if (entry.stopReason === "shutdown") {
      this.claimed.delete(issue.id);
      return;
    }
    if (entry.stopReason === "terminal") {
      await removeWorkspace(this.config, issue.identifier).catch(() => undefined);
      this.release(issue.id);
      return;
    }
    if (entry.stopReason === "inactive" || outcome.kind === "inactive" || outcome.kind === "handoff") {
      this.release(issue.id);
      return;
    }

    const rateLimited = outcome.kind === "failed" && outcome.rateLimited;
    // Switching agents after a rate limit is not the issue's fault, so it does not use up an attempt.
    const attempt = rateLimited ? Math.max(entry.attempt, 1) : entry.attempt + 1;
    // max_attempts is the total number of runs (first run + retries). Rate-limit switches never give up.
    if (!rateLimited && attempt >= this.config.agent.maxAttempts) {
      this.totals.failures++;
      const why = outcome.kind === "failed" ? outcome.error : "ran out of turns without writing a result";
      await this.tracker
        .comment(issue, `${MARKER}\n⛔ Conductor gave up after ${attempt} attempts.\n\nLast error: ${why.slice(0, 1500)}`)
        .catch(() => undefined);
      this.telemetry.event("gave_up", issue, entry.agent, `gave up after ${attempt} attempts: ${why.slice(0, 200)}`);
      await this.tracker.setState(issue, this.config.tracker.blockedState).catch(() => undefined);
      this.release(issue.id);
      return;
    }

    if (outcome.kind === "exhausted") {
      this.scheduleRetry(issue, attempt, "max turns reached; continuing", [], 1_000);
    } else if (rateLimited) {
      this.router.coolDown(entry.agent, this.now());
      log("warn", "agent_cooling_down", { agent: entry.agent, ms: this.config.agent.rateLimitCooldownMs });
      this.telemetry.agent(entry.agent).rateLimits++;
      this.telemetry.event(
        "cooldown",
        issue,
        entry.agent,
        `${entry.agent} cooling down ${Math.round(this.config.agent.rateLimitCooldownMs / 60000)} min: ${outcome.kind === "failed" ? outcome.error.slice(0, 160) : ""}`,
      );
      // Try another agent right away; the workspace (and its commits) carries over.
      this.scheduleRetry(issue, attempt, outcome.error, [...new Set([...previousExclude, entry.agent])], 1_000);
    } else {
      this.totals.failures++;
      const err = outcome.kind === "failed" ? outcome.error : "unknown";
      this.scheduleRetry(issue, attempt, err, [], backoffMs(attempt, this.config.agent.maxRetryBackoffMs));
    }
  }

  private release(issueId: string) {
    this.claimed.delete(issueId);
    const r = this.retries.get(issueId);
    if (r) clearTimeout(r.timer);
    this.retries.delete(issueId);
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string, exclude: string[], delayMs: number) {
    const existing = this.retries.get(issue.id);
    if (existing) clearTimeout(existing.timer);
    this.claimed.add(issue.id);
    const timer = setTimeout(() => void this.fireRetry(issue.id), delayMs);
    this.retries.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAt: this.now() + delayMs,
      error: error.slice(0, 500),
      exclude,
      timer,
    });
    log("info", "retry_scheduled", { issue: issue.identifier, attempt, delayMs, error: error.slice(0, 200) });
    this.telemetry.event("retry", issue, null, `retry #${attempt} in ${Math.round(delayMs / 1000)}s: ${error.slice(0, 160)}`);
  }

  /** Retries that left the queue but have not dispatched yet (awaiting the tracker). */
  private firingRetries = 0;

  private async fireRetry(issueId: string) {
    this.firingRetries++;
    try {
      await this.fireRetryInner(issueId);
    } finally {
      this.firingRetries--;
    }
  }

  private async fireRetryInner(issueId: string) {
    const entry = this.retries.get(issueId);
    if (!entry || this.stopped) return;
    this.retries.delete(issueId);
    let issue: Issue | undefined;
    try {
      [issue] = await this.tracker.fetchByIds([issueId]);
    } catch (err) {
      this.scheduleRetryById(entry, `refresh failed: ${(err as Error).message}`);
      return;
    }
    if (!issue) return this.release(issueId);
    if (isTerminal(issue, this.config)) {
      await removeWorkspace(this.config, issue.identifier).catch(() => undefined);
      return this.release(issueId);
    }
    if (!isActive(issue, this.config) || !isRoutable(issue, this.config)) return this.release(issueId);
    if (this.availableSlots() <= 0) {
      this.scheduleRetry(issue, entry.attempt, "no available orchestrator slots", entry.exclude, 5_000);
      return;
    }
    // Drop excluded agents once everything is excluded, so we never deadlock.
    const exclude = entry.exclude.length >= this.config.routing.default.length ? [] : entry.exclude;
    this.claimed.delete(issueId);
    this.dispatch(issue, entry.attempt, exclude);
  }

  private scheduleRetryById(entry: RetryEntry, error: string) {
    const timer = setTimeout(() => void this.fireRetry(entry.issueId), 30_000);
    this.retries.set(entry.issueId, { ...entry, error, dueAt: this.now() + 30_000, timer });
  }

  // ---------- observability ----------

  snapshot() {
    const now = this.now();
    const iso = (t: number) => new Date(t).toISOString();
    const config = this.config;
    const cooldowns = this.router.cooldowns(now);
    const runningBy = (agent: string) => [...this.running.values()].filter((r) => r.agent === agent).length;
    return {
      generatedAt: iso(now),
      version: this.telemetry.version,
      bootedAt: iso(this.bootedAt),
      workflow: this.workflow.path,
      repo: config.tracker.repo,
      tracker: {
        kind: config.tracker.kind,
        team: config.tracker.team || null,
        project: config.tracker.project || null,
        reviewState: config.tracker.reviewState,
        blockedState: config.tracker.blockedState,
      },
      limits: {
        maxConcurrentAgents: config.agent.maxConcurrentAgents,
        maxTurns: config.agent.maxTurns,
        maxAttempts: config.agent.maxAttempts,
        pollIntervalMs: config.polling.intervalMs,
        stallTimeoutMs: config.agent.stallTimeoutMs,
        rateLimitCooldownMs: config.agent.rateLimitCooldownMs,
      },
      counts: { running: this.running.size, retrying: this.retries.size },
      totals: this.totals,
      cooldowns: Object.fromEntries(Object.entries(cooldowns).map(([a, until]) => [a, iso(until)])),
      agents: Object.entries(config.agents).map(([name, a]) => ({
        name,
        kind: a.kind,
        enabled: a.enabled,
        inRotation: config.routing.default.includes(name),
        maxConcurrent: a.maxConcurrent,
        running: runningBy(name),
        cooldownUntil: cooldowns[name] ? iso(cooldowns[name]!) : null,
        stats: this.telemetry.statsFor(name),
      })),
      running: [...this.running.values()].map((r) => ({
        issue: r.issue.identifier,
        title: r.issue.title,
        url: r.issue.url,
        state: r.issue.state,
        agent: r.agent,
        phase: r.phase,
        attempt: r.attempt,
        turn: r.turn,
        maxTurns: config.agent.maxTurns,
        sessionId: r.sessionId,
        branch: r.branch,
        prUrl: r.prUrl,
        startedAt: iso(r.startedAt),
        lastEventAt: iso(r.lastEventAt),
        lastText: r.lastText,
        lastTool: r.lastTool ? { ...r.lastTool, at: iso(r.lastTool.at) } : null,
        toolCalls: r.toolCalls,
        usage: r.usage,
      })),
      retrying: [...this.retries.values()].map((r) => ({
        issue: r.identifier,
        attempt: r.attempt,
        dueAt: iso(r.dueAt),
        error: r.error,
        exclude: r.exclude,
      })),
      finished: this.telemetry.finished.map((f) => ({ ...f, startedAt: iso(f.startedAt), endedAt: iso(f.endedAt) })),
      activity: this.telemetry.activity.slice(0, 100).map((a) => ({ ...a, at: iso(a.at) })),
    };
  }
}
