// The orchestrator owns all scheduling state: which issues are claimed, running or waiting to
// retry. Workers report back here; nothing else mutates this state. Modeled on the Symphony spec
// (poll -> reconcile -> dispatch, exponential backoff, tracker-driven recovery, no database).

import { statSync } from "node:fs";
import type { AgentEvent, Config, Issue, TurnResult, Usage, Workflow } from "./types.ts";
import type { PullRequestRef, Tracker } from "./tracker/tracker.ts";
import { norm } from "./tracker/tracker.ts";
import { Router } from "./router.ts";
import { runTurn as defaultRunTurn, type RunTurnOptions } from "./agents/runner.ts";
import { loadWorkflow, renderPrompt, validateForDispatch } from "./workflow.ts";
import {
  REPORT_FILE,
  afterRun,
  agentEnv,
  clearReport,
  finalizeCommits,
  prepareWorkspace,
  pushBranch,
  readReport,
  readSession,
  removeWorkspace,
  workspacePath,
  writeSession,
} from "./workspace.ts";
import { log } from "./log.ts";

export const MARKER = "<!-- conductor -->";

export function protocolFooter(): string {
  return `

---
Conductor protocol (always applies):
- You are running unattended. Nobody will answer questions; make reasonable decisions and keep going.
- Work only inside the current directory. Commit your work with clear messages on the current branch. Do not push and do not open pull requests: Conductor does that after you finish.
- When the task is complete, write \`${REPORT_FILE}\` containing JSON: {"status":"done","summary":"<what you changed and how you verified it>","pr_title":"<short PR title>"}.
- If you cannot proceed because something outside your control is missing (access, secrets, unclear requirements), write {"status":"blocked","summary":"<what is missing and what a human must do>"} to the same file.
- Until that file exists, Conductor will keep asking you to continue.`;
}

export function continuationPrompt(turn: number, maxTurns: number): string {
  return `Continue working on the same task (turn ${turn} of ${maxTurns}). Pick up from the current state of the workspace. When finished, write ${REPORT_FILE} as described earlier; if blocked, write it with status "blocked".`;
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
      this.dispatch(issue, null, []);
    }
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
    };
    this.claimed.add(issue.id);
    this.running.set(issue.id, entry);
    this.totals.runs++;
    log("info", "dispatched", { issue: issue.identifier, agent, attempt, state: issue.state });
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
    try {
      const session = readSession(ws.path);
      let sessionId = session && session.agent === agent ? session.sessionId : null;
      const pr = ws.isGit ? await this.tracker.findPullRequest(issue, ws.branch).catch(() => null) : null;
      const feedback = pr || norm(issue.state) === "rework" ? await this.tracker.fetchFeedback(issue, pr).catch(() => "") : "";
      clearReport(ws.path);
      const env = agentEnv(config);

      for (let turn = 1; turn <= config.agent.maxTurns; turn++) {
        entry.turn = turn;
        const prompt =
          turn === 1
            ? (await renderPrompt(this.workflow.promptTemplate, {
                issue: issue as unknown as Record<string, unknown>,
                attempt: entry.attempt || null,
                agent,
                feedback,
              })) + protocolFooter()
            : continuationPrompt(turn, config.agent.maxTurns);

        const result = await this.runTurnImpl({
          agent: agentCfg,
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
        if (!result.ok) {
          log("warn", "turn_failed", { issue: issue.identifier, agent, turn, reason: result.reason, error: result.error?.slice(0, 500) });
          return { kind: "failed", error: result.error ?? result.reason, rateLimited: result.rateLimited };
        }
        log("info", "turn_completed", { issue: issue.identifier, agent, turn, usage: result.usage });

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

    if (ws.isGit && config.handoff.openPullRequest) {
      const { ahead } = await finalizeCommits(ws.path, issue);
      if (ahead > 0) {
        await pushBranch(ws.path, ws.branch);
        if (!pr) {
          pr = await this.tracker.openPullRequest({
            issue,
            branch: ws.branch,
            title: report.prTitle || `${issue.title} (#${issue.number})`,
            body: `Closes #${issue.number}\n\n${report.summary}\n\n---\n${MARKER}\n_Implemented by **${agent}** via Conductor._`,
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
    this.totals.handoffs++;
    log("info", "handoff", { issue: issue.identifier, agent, status: report.status, pr: pr?.url });
    return { kind: "handoff", status: report.status, prUrl: pr?.url ?? null };
  }

  private onAgentEvent(entry: RunEntry, e: AgentEvent) {
    entry.lastEventAt = this.now();
    if (e.type === "text") entry.lastText = e.text.slice(0, 500);
    if (e.type === "session") entry.sessionId = e.sessionId;
    if (e.type === "tool") log("debug", "agent_tool", { issue: entry.issue.identifier, agent: entry.agent, tool: e.name, detail: e.detail });
    if (e.type === "rate_limit") log("warn", "agent_rate_limit", { agent: entry.agent, message: e.message });
  }

  private addUsage(entry: RunEntry, u: Usage) {
    entry.usage.inputTokens += u.inputTokens;
    entry.usage.outputTokens += u.outputTokens;
    this.totals.inputTokens += u.inputTokens;
    this.totals.outputTokens += u.outputTokens;
  }

  // ---------- worker exit + retries ----------

  private async onWorkerExit(entry: RunEntry, outcome: WorkerOutcome, previousExclude: string[]) {
    const { issue } = entry;
    this.running.delete(issue.id);
    log("info", "worker_exited", { issue: issue.identifier, agent: entry.agent, outcome: outcome.kind, stop: entry.stopReason });

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
      await this.tracker.setState(issue, this.config.tracker.blockedState).catch(() => undefined);
      this.release(issue.id);
      return;
    }

    if (outcome.kind === "exhausted") {
      this.scheduleRetry(issue, attempt, "max turns reached; continuing", [], 1_000);
    } else if (rateLimited) {
      this.router.coolDown(entry.agent, this.now());
      log("warn", "agent_cooling_down", { agent: entry.agent, ms: this.config.agent.rateLimitCooldownMs });
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
  }

  private async fireRetry(issueId: string) {
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
    return {
      generatedAt: new Date(now).toISOString(),
      workflow: this.workflow.path,
      repo: this.config.tracker.repo,
      counts: { running: this.running.size, retrying: this.retries.size },
      totals: this.totals,
      cooldowns: Object.fromEntries(
        Object.entries(this.router.cooldowns(now)).map(([a, until]) => [a, new Date(until).toISOString()]),
      ),
      running: [...this.running.values()].map((r) => ({
        issue: r.issue.identifier,
        title: r.issue.title,
        url: r.issue.url,
        state: r.issue.state,
        agent: r.agent,
        attempt: r.attempt,
        turn: r.turn,
        sessionId: r.sessionId,
        startedAt: new Date(r.startedAt).toISOString(),
        lastEventAt: new Date(r.lastEventAt).toISOString(),
        lastText: r.lastText,
        usage: r.usage,
      })),
      retrying: [...this.retries.values()].map((r) => ({
        issue: r.identifier,
        attempt: r.attempt,
        dueAt: new Date(r.dueAt).toISOString(),
        error: r.error,
        exclude: r.exclude,
      })),
    };
  }
}
