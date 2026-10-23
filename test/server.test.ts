// Dashboard server and the snapshot data it renders.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { MemoryTracker } from "../src/tracker/memory.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { hostAllowed, startServer } from "../src/server.ts";
import { setLogSink } from "../src/log.ts";
import type { TurnResult } from "../src/types.ts";

setLogSink(() => {});
const root = mkdtempSync(join(tmpdir(), "conductor-server-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeOrch() {
  const path = join(root, `W-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, `---\ntracker: {kind: memory, repo: me/demo}\nworkspace: {root: ${join(root, "ws")}}\n---\nDo {{ issue.title }}`);
  const wf = parseWorkflow(require("node:fs").readFileSync(path, "utf8"), path);
  const tracker = new MemoryTracker(wf.config);
  const orch = new Orchestrator(wf, {
    tracker,
    runTurn: async (o): Promise<TurnResult> => {
      o.onEvent?.({ type: "tool", name: "shell", detail: "bun test" });
      o.onEvent?.({ type: "text", text: "All tests pass." });
      writeFileSync(join(o.cwd, ".conductor/result.json"), JSON.stringify({ status: "done", summary: "Did it." }));
      return {
        ok: true,
        sessionId: "s1",
        finalText: "All tests pass.",
        usage: { inputTokens: 120, outputTokens: 30 },
        error: null,
        rateLimited: false,
        permissionDenied: null,
        exitCode: 0,
        reason: "completed",
      };
    },
  });
  return { orch, tracker };
}

describe("dashboard", () => {
  test("only loopback Host headers are accepted", () => {
    expect(hostAllowed("127.0.0.1:4141", 4141)).toBe(true);
    expect(hostAllowed("localhost:4141", 4141)).toBe(true);
    expect(hostAllowed("evil.example:4141", 4141)).toBe(false);
    expect(hostAllowed("127.0.0.1:9999", 4141)).toBe(false);
    expect(hostAllowed(null, 4141)).toBe(false);
  });

  test("snapshot records activity, per-agent stats and finished runs", async () => {
    const { orch, tracker } = makeOrch();
    tracker.add({ number: 1, title: "Make a page", labels: ["conductor", "agent:claude"] });
    await orch.tick();
    await orch.drain();
    const s = orch.snapshot();
    expect(s.tracker.kind).toBe("memory");
    expect(s.activity.map((a) => a.kind)).toEqual(["handoff", "turn", "dispatched"]);
    const claude = s.agents.find((a) => a.name === "claude")!;
    expect(claude.stats).toMatchObject({ runs: 1, handoffs: 1, toolCalls: 1, inputTokens: 120, outputTokens: 30 });
    expect(s.finished[0]).toMatchObject({ issue: "mem-1", agent: "claude", outcome: "handoff", status: "done", turns: 1 });
    expect(s.running).toEqual([]);
    await orch.stop();
  });

  test("serves the page, JSON state and an SSE stream", async () => {
    const { orch } = makeOrch();
    const server = startServer(orch, 0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const page = await fetch(`${base}/`);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain("<title>Conductor 运行面板</title>");
      expect(html).not.toContain("http://cdn");

      const state = await (await fetch(`${base}/api/v1/state`)).json();
      expect(state.limits.maxTurns).toBe(10);

      const res = await fetch(`${base}/api/v1/stream`);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const first = new TextDecoder().decode(value);
      expect(first.startsWith("data: {")).toBe(true);
      expect(JSON.parse(first.slice(6).trim()).repo).toBe("me/demo");
      await reader.cancel();

      const bad = await fetch(`${base}/api/v1/state`, { headers: { host: "evil.example" } });
      expect(bad.status).toBe(403);
    } finally {
      server.stop(true);
      await orch.stop();
    }
  });
});
