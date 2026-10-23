// End-to-end orchestrator scenarios with an in-memory tracker, a local bare git "origin" and a
// scripted fake agent (no real CLIs are launched).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { MemoryTracker } from "../src/tracker/memory.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { setLogSink } from "../src/log.ts";
import { workspacePath } from "../src/workspace.ts";
import type { TurnResult } from "../src/types.ts";
import type { RunTurnOptions } from "../src/agents/runner.ts";

const root = mkdtempSync(join(tmpdir(), "conductor-orch-"));
const origin = join(root, "origin.git");
const logs: string[] = [];

beforeAll(async () => {
  setLogSink((l) => logs.push(l));
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  const seed = join(root, "seed");
  mkdirSync(seed);
  const sh = (cmd: string, cwd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd, env: process.env });
  sh(`git init -q -b main && echo hi > README.md && git add . && git commit -qm init && git clone -q --bare . ${origin}`, seed);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function setup(
  extra = "",
  runTurn?: (o: RunTurnOptions) => Promise<TurnResult>,
  agentLine = "agent: {max_turns: 3, max_attempts: 3, rate_limit_cooldown_ms: 60000}",
  afterCreate = `git clone -q ${origin} .`,
) {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir);
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(
    path,
    `---
tracker: {kind: memory, repo: me/demo}
workspace: {root: ${join(dir, "ws")}}
hooks:
  after_create: ${afterCreate}
${agentLine}
verify: {commands: [bun test]}
${extra}
---
Fix {{ issue.title }} using {{ agent }}{% if attempt %} (attempt {{ attempt }}){% endif %}.`,
  );
  const wf = parseWorkflow(readFileSync(path, "utf8"), path);
  const tracker = new MemoryTracker(wf.config);
  const calls: RunTurnOptions[] = [];
  const orch = new Orchestrator(wf, {
    tracker,
    runTurn: async (o) => {
      calls.push(o);
      return runTurn ? runTurn(o) : doneTurn(o);
    },
  });
  return { wf, tracker, orch, calls, dir };
}

const ok = (sessionId: string, extra: Partial<TurnResult> = {}): TurnResult => ({
  ok: true,
  sessionId,
  finalText: "ok",
  usage: { inputTokens: 10, outputTokens: 5 },
  error: null,
  rateLimited: false,
  permissionDenied: null,
  exitCode: 0,
  reason: "completed",
  ...extra,
});

async function doneTurn(o: RunTurnOptions): Promise<TurnResult> {
  writeFileSync(join(o.cwd, "fix.txt"), `fixed by ${o.agent.kind}\n`);
  writeFileSync(join(o.cwd, ".conductor/result.json"), JSON.stringify({ status: "done", summary: "Fixed it.", pr_title: "Fix it" }));
  return ok(`${o.agent.kind}-session`);
}

async function waitFor(cond: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("orchestrator", () => {
  test("happy path: Todo -> run -> push branch -> PR -> Human Review", async () => {
    const { tracker, orch, calls, wf } = setup();
    const issue = tracker.add({ number: 7, title: "the login bug" });
    await orch.tick();
    await waitFor(() => tracker.issues.get(issue.id)!.state === "Human Review");
    await Promise.allSettled(orch.workerPromises.values());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.kind).toBe("codex");
    expect(calls[0]!.prompt).toContain("Fix the login bug using codex.");
    expect(calls[0]!.prompt).toContain(".conductor/result.json");
    expect(calls[0]!.prompt).toContain("Verify your work by running: `bun test`");
    expect(calls[0]!.prompt).toContain("Conductor commits them for you");
    // Native sandbox mode (default): codex gets its permission profile, no allow-list needed.
    expect(calls[0]!.agent.args).toContain('default_permissions="conductor"');
    expect(calls[0]!.agent.args.join(" ")).toContain('":workspace_roots"="write"');
    expect(calls[0]!.agent.allowedCommands).toEqual([]);
    expect(calls[0]!.sessionId).toBeNull();
    expect(calls[0]!.env.GITHUB_TOKEN).toBeUndefined();

    expect(tracker.prs.get("7")?.headBranch).toBe("conductor/7-the-login-bug");
    const branch = Bun.spawnSync(["git", "--git-dir", origin, "log", "--oneline", "conductor/7-the-login-bug"]).stdout.toString();
    expect(branch).toContain("conductor: changes for #7");
    expect(tracker.comments.map((c) => c.body).join("\n")).toContain("finished with status `done`");

    const ws = workspacePath(wf.config.workspace.root, "mem-7");
    expect(JSON.parse(readFileSync(join(ws, ".conductor/session.json"), "utf8")).sessionId).toBe("codex-session");
    expect(orch.running.size).toBe(0);
    expect(orch.claimed.size).toBe(0);
    await orch.stop();
  });

  test("rate-limited agent cools down and another agent takes over the same workspace", async () => {
    const { tracker, orch, calls } = setup("", async (o) => {
      if (o.agent.kind === "codex") {
        writeFileSync(join(o.cwd, "partial.txt"), "wip\n");
        return { ...ok("c1"), ok: false, error: "Selected model is at capacity", rateLimited: true, reason: "failed" };
      }
      expect(existsSync(join(o.cwd, "partial.txt"))).toBe(true); // work carried over
      return doneTurn(o);
    });
    tracker.add({ number: 8, title: "flaky test" });
    await orch.tick();
    await waitFor(() => tracker.issues.get("8")!.state === "Human Review");
    expect(calls.map((c) => c.agent.kind)).toEqual(["codex", "claude"]);
    expect(Object.keys(orch.snapshot().cooldowns)).toEqual(["codex"]);
    await orch.stop();
  });

  test("keeps the session going across turns until the agent writes its report", async () => {
    let turns = 0;
    const { tracker, orch, calls } = setup("", async (o) => {
      turns++;
      if (turns < 2) return ok("s-multi");
      return doneTurn(o);
    });
    tracker.add({ number: 9, title: "multi" });
    await orch.tick();
    await waitFor(() => tracker.issues.get("9")!.state === "Human Review");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sessionId).toBe("s-multi");
    expect(calls[1]!.prompt).toContain("Continue working");
    await orch.stop();
  });

  test("closing the issue mid-run stops the agent and removes the workspace", async () => {
    const { tracker, orch, wf } = setup("", async (o) => {
      await new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve()));
      return { ...ok("s"), ok: false, reason: "aborted", error: "turn aborted" };
    });
    tracker.add({ number: 10, title: "cancel me" });
    await orch.tick();
    await waitFor(() => orch.running.get("10")?.turn === 1);
    const ws = workspacePath(wf.config.workspace.root, "mem-10");
    expect(existsSync(ws)).toBe(true);
    tracker.issues.get("10")!.state = "Closed";
    await orch.tick();
    await waitFor(() => orch.running.size === 0 && orch.claimed.size === 0);
    await Promise.allSettled(orch.workerPromises.values());
    expect(existsSync(ws)).toBe(false);
    await orch.stop();
  });

  test("a refused tool call resumes the same session with guidance instead of failing", async () => {
    let turns = 0;
    const { tracker, orch, calls } = setup("sandbox: {mode: none}", async (o) => {
      turns++;
      if (turns === 1) {
        return { ...ok("g-1"), ok: false, reason: "failed", error: "grok stopped: cancelled", permissionDenied: "Execute `gh issue view 5`" };
      }
      return doneTurn(o);
    });
    tracker.add({ number: 15, title: "denied once", labels: ["conductor", "agent:grok"] });
    await orch.tick();
    await waitFor(() => tracker.issues.get("15")!.state === "Human Review");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sessionId).toBe("g-1");
    expect(calls[1]!.prompt).toContain("not permitted here: Execute `gh issue view 5`");
    expect(calls[1]!.prompt).toContain("`bun test`");
    await orch.stop();
  });

  test("gives up after max_attempts and marks the issue Blocked", async () => {
    const { tracker, orch, calls } = setup(
      "",
      async () => ({ ...ok("s"), ok: false, error: "compile error", reason: "failed" }),
      "agent: {max_turns: 1, max_attempts: 1}",
    );
    tracker.add({ number: 11, title: "hopeless" });
    await orch.tick();
    await waitFor(() => tracker.issues.get("11")!.state === "Blocked");
    expect(calls).toHaveLength(1);
    expect(tracker.comments.at(-1)!.body).toContain("gave up after 1 attempts");
    await orch.stop();
  });

  test("agent label pins the issue; blocked report goes to Blocked state", async () => {
    const { tracker, orch, calls } = setup("", async (o) => {
      writeFileSync(join(o.cwd, ".conductor/result.json"), JSON.stringify({ status: "blocked", summary: "Need an API key." }));
      return ok("g");
    });
    tracker.add({ number: 12, title: "needs key", labels: ["conductor", "agent:grok"] });
    await orch.tick();
    await waitFor(() => tracker.issues.get("12")!.state === "Blocked");
    expect(calls[0]!.agent.kind).toBe("grok");
    expect(tracker.prs.size).toBe(0); // no commits -> no PR
    await orch.stop();
  });

  test("issues without the required label are ignored", async () => {
    const { tracker, orch, calls } = setup();
    tracker.add({ number: 13, title: "not mine", labels: ["bug"] });
    await orch.tick();
    await Bun.sleep(50);
    expect(calls).toHaveLength(0);
    await orch.stop();
  });
});

test("handoff works when origin/HEAD is missing", async () => {
  const { tracker, orch } = setup("", undefined, undefined, `git clone -q ${origin} . && git remote set-head origin -d`);
  tracker.add({ number: 14, title: "no origin head" });
  await orch.tick();
  await waitFor(() => tracker.issues.get("14")!.state === "Human Review");
  expect(tracker.prs.get("14")?.headBranch).toBe("conductor/14-no-origin-head");
  await orch.stop();
});

test("drain waits for a retry that is in flight", async () => {
  let turns = 0;
  const { tracker, orch, calls } = setup(
    "",
    async (o) => {
      turns++;
      if (turns === 1) return { ...ok("r"), ok: false, error: "boom", reason: "failed" };
      return doneTurn(o);
    },
    "agent: {max_turns: 1, max_attempts: 3, max_retry_backoff_ms: 1}",
  );
  // Slow tracker refresh: the retry has left the queue but not dispatched yet.
  const fetchByIds = tracker.fetchByIds.bind(tracker);
  tracker.fetchByIds = async (ids) => {
    await Bun.sleep(300);
    return fetchByIds(ids);
  };
  tracker.add({ number: 16, title: "retry once" });
  await orch.tick();
  await orch.drain();
  expect(calls).toHaveLength(2);
  expect(tracker.issues.get("16")!.state).toBe("Human Review");
  await orch.stop();
});

test("a handed-off issue moved back by an automation is held; human feedback releases it", async () => {
  const { tracker, orch, calls } = setup();
  tracker.add({ number: 17, title: "held" });
  await orch.tick();
  await waitFor(() => tracker.issues.get("17")!.state === "Human Review");
  await Promise.allSettled(orch.workerPromises.values());
  expect(calls).toHaveLength(1);

  // An automation (e.g. Linear's "PR opened") moves it back to an active state.
  tracker.issues.get("17")!.state = "In Progress";
  await orch.tick();
  await Bun.sleep(50);
  expect(calls).toHaveLength(1); // not picked up again
  expect(tracker.issues.get("17")!.state).toBe("Human Review"); // restored once

  // Moved back again without feedback: still held, and not fought over a second time.
  tracker.issues.get("17")!.state = "In Progress";
  await orch.tick();
  await Bun.sleep(50);
  expect(calls).toHaveLength(1);
  expect(tracker.issues.get("17")!.state).toBe("In Progress");

  // A reviewer asks for changes: now it is a real rework request.
  tracker.activity.set("17", new Date(Date.now() + 1000).toISOString());
  await orch.tick();
  await waitFor(() => calls.length === 2);
  await waitFor(() => tracker.issues.get("17")!.state === "Human Review");
  await orch.stop();
});
