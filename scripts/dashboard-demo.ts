#!/usr/bin/env bun
// Runs the dashboard against fake agents so it can be looked at and tweaked without real CLIs:
//   bun scripts/dashboard-demo.ts [port]      (default 4142)
// Uses an in-memory tracker and a throwaway git "origin" in a temp dir. Nothing leaves the machine.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { MemoryTracker } from "../src/tracker/memory.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { startServer } from "../src/server.ts";
import { setLogSink } from "../src/log.ts";
import type { RunTurnOptions } from "../src/agents/runner.ts";
import type { TurnResult } from "../src/types.ts";

setLogSink(() => {});
const port = Number(Bun.argv[2] ?? 4142);
const root = mkdtempSync(join(tmpdir(), "conductor-demo-"));
const origin = join(root, "origin.git");
const seed = join(root, "seed");
mkdirSync(seed);
const sh = (cmd: string, cwd: string) =>
  Bun.spawnSync(["bash", "-c", cmd], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "d@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "d@example.com" },
  });
sh(`git init -q -b main && echo hi > README.md && git add . && git commit -qm init && git clone -q --bare . ${origin}`, seed);
Object.assign(process.env, { GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "d@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "d@example.com" });

const wfPath = join(root, "WORKFLOW.md");
writeFileSync(
  wfPath,
  `---
tracker: {kind: memory, repo: demo/site}
workspace: {root: ${join(root, "ws")}}
hooks:
  after_create: git clone -q ${origin} .
polling: {interval_ms: 5000}
agent: {max_concurrent_agents: 4, max_turns: 6, max_attempts: 3, rate_limit_cooldown_ms: 240000, stall_timeout_ms: 60000}
agents:
  codex: {max_concurrent: 2}
  claude: {max_concurrent: 2}
  agy: {max_concurrent: 1}
  grok: {max_concurrent: 1}
---
Do {{ issue.title }}`,
);
const wf = parseWorkflow(readFileSync(wfPath, "utf8"), wfPath);
const tracker = new MemoryTracker(wf.config);
let prNo = 40;
tracker.openPullRequest = async (input) => {
  const pr = { number: ++prNo, url: `https://github.com/demo/site/pull/${prNo}`, headBranch: input.branch };
  tracker.prs.set(input.issue.id, pr);
  return pr;
};

const TITLES = [
  "高中站：必修一 2.2 基本不等式",
  "Fix long formulas widening the page on phones",
  "洞察 ep12：拖动三角形的互动页",
  "Add practice questions to episode 07",
  "练一练：判分时允许等价表达式",
  "Sitemap and Open Graph cards",
  "选必二 4.3 等比数列：互动图",
];
TITLES.forEach((title, i) =>
  tracker.add({ number: i + 1, title, identifier: `PY-${41 + i}`, url: `https://linear.app/demo/issue/PY-${41 + i}` }),
);

const TOOLS = [
  ["read_file", "src/pages/lesson.astro"],
  ["shell", "bun test"],
  ["edit", "public/play/ep12.html"],
  ["shell", "python3 site/tools/check_play.py ep12"],
  ["grep", "data-fold-later"],
  ["shell", "npm run build"],
];
const sleep = (ms: number) => Bun.sleep(ms);
const turnsFor = new Map<string, number>();

async function fakeTurn(o: RunTurnOptions): Promise<TurnResult> {
  const key = o.cwd;
  const turn = (turnsFor.get(key) ?? 0) + 1;
  turnsFor.set(key, turn);
  const kind = o.agent.kind;
  const usage = { inputTokens: 20_000 + Math.floor(Math.random() * 60_000), outputTokens: 400 + Math.floor(Math.random() * 3000) };
  const base: TurnResult = { ok: true, sessionId: `${kind}-${turn}`, finalText: "", usage, error: null, rateLimited: false, permissionDenied: null, exitCode: 0, reason: "completed" };
  o.onEvent?.({ type: "session", sessionId: base.sessionId! });

  // codex reports "at capacity" on its first turn of each workspace, to show cooldown + failover.
  if (kind === "codex" && turn === 1) {
    await sleep(2500);
    return { ...base, ok: false, error: "Selected model is at capacity. Please try a different model.", rateLimited: true, reason: "failed" };
  }
  const steps = 4 + Math.floor(Math.random() * 6);
  for (let i = 0; i < steps; i++) {
    if (o.signal?.aborted) return { ...base, ok: false, reason: "aborted", error: "turn aborted" };
    const [name, detail] = TOOLS[Math.floor(Math.random() * TOOLS.length)]!;
    o.onEvent?.({ type: "tool", name: name!, detail });
    await sleep(1500 + Math.random() * 2500);
    if (i % 2 === 1) o.onEvent?.({ type: "text", text: `Checked ${detail}; ${i < steps - 1 ? "continuing with the next step." : "everything passes now."}` });
  }
  if (kind === "grok" && turn === 1) return { ...base, ok: false, error: "grok stopped: cancelled", reason: "failed", permissionDenied: "Execute `gh issue view 5 && ls`" };
  if (turn >= 2 || Math.random() < 0.4) {
    writeFileSync(join(o.cwd, `change-${turn}.txt`), "demo\n");
    const blocked = o.prompt.includes("Sitemap");
    writeFileSync(
      join(o.cwd, ".conductor/result.json"),
      JSON.stringify(blocked ? { status: "blocked", summary: "Need the production domain for canonical URLs." } : { status: "done", summary: "Implemented and verified with the project's checks.", pr_title: "Demo change" }),
    );
  }
  return { ...base, finalText: "Turn finished." };
}

const orch = new Orchestrator(wf, { tracker, runTurn: fakeTurn });
startServer(orch, port);
await orch.start();
console.log(`dashboard demo: http://127.0.0.1:${port}/  (Ctrl-C to stop)`);
