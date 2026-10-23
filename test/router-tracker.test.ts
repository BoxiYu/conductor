import { describe, expect, test } from "bun:test";
import { Router } from "../src/router.ts";
import { deriveState, derivePriority } from "../src/tracker/tracker.ts";
import { backoffMs, isRoutable, sortForDispatch } from "../src/orchestrator.ts";
import { sanitizeIdentifier, workspacePath, branchName } from "../src/workspace.ts";
import { parseWorkflow } from "../src/workflow.ts";
import type { Issue } from "../src/types.ts";

const config = parseWorkflow("---\ntracker: {repo: a/b}\nagent: {rate_limit_cooldown_ms: 1000}\n---\n", "/tmp/W.md").config;

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "1",
  identifier: "b-1",
  number: 1,
  branchKey: "1",
  title: "Fix the thing!",
  description: null,
  state: "Todo",
  labels: ["conductor"],
  url: "",
  priority: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: null,
  ...over,
});

describe("state labels", () => {
  const rules = { statePrefix: "state:", defaultState: "Todo", terminalStates: ["Closed"], precedence: ["Human Review", "Rework", "In Progress"] };
  test("derives state", () => {
    expect(deriveState(false, ["state:rework"], rules)).toBe("Closed");
    expect(deriveState(true, [], rules)).toBe("Todo");
    expect(deriveState(true, ["State: in progress"], rules)).toBe("In Progress");
    // rework beats in progress when both labels are present
    expect(deriveState(true, ["state:In Progress", "state:Rework"], rules)).toBe("Rework");
  });
  test("priority labels", () => {
    expect(derivePriority(["priority:2"])).toBe(2);
    expect(derivePriority(["P1"])).toBe(1);
    expect(derivePriority(["bug"])).toBeNull();
  });
});

describe("dispatch helpers", () => {
  test("sorts by priority, then age", () => {
    const sorted = sortForDispatch([
      issue({ id: "a", identifier: "a", priority: null, createdAt: "2026-01-01" }),
      issue({ id: "b", identifier: "b", priority: 2, createdAt: "2026-03-01" }),
      issue({ id: "c", identifier: "c", priority: 2, createdAt: "2026-02-01" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });
  test("backoff", () => {
    expect(backoffMs(1, 300_000)).toBe(10_000);
    expect(backoffMs(3, 300_000)).toBe(40_000);
    expect(backoffMs(10, 300_000)).toBe(300_000);
  });
  test("required labels", () => {
    expect(isRoutable(issue(), config)).toBe(true);
    expect(isRoutable(issue({ labels: ["bug"] }), config)).toBe(false);
  });
});

describe("workspace paths", () => {
  test("sanitizes and stays under root", () => {
    expect(sanitizeIdentifier("../../etc")).toBe("__.._etc");
    expect(workspacePath("/w", "../x")).toBe("/w/__x");
    expect(branchName(config, issue())).toBe("conductor/1-fix-the-thing");
  });
});

describe("router", () => {
  const view = (running: Record<string, number> = {}, now = 0) => ({ running: (a: string) => running[a] ?? 0, now: () => now });

  test("rotates across default agents", () => {
    const r = new Router(config);
    expect([r.pick(issue(), view()), r.pick(issue(), view()), r.pick(issue(), view())]).toEqual(["codex", "claude", "agy"]);
  });

  test("label pins an agent and waits when it is busy", () => {
    const r = new Router(config);
    const pinned = issue({ labels: ["conductor", "agent:Grok"] });
    expect(r.pick(pinned, view())).toBe("grok");
    expect(r.pick(pinned, view({ grok: 2 }))).toBeNull();
  });

  test("prefers previous agent, skips cooled-down agents", () => {
    const r = new Router(config);
    expect(r.pick(issue(), view(), "agy")).toBe("agy");
    r.coolDown("agy", 0);
    expect(r.pick(issue(), view({}, 500), "agy")).toBe("codex");
    expect(r.pick(issue(), view({}, 2000), "agy")).toBe("agy");
  });

  test("exclude list", () => {
    const r = new Router(config);
    expect(r.pick(issue(), view(), "codex", ["codex"])).toBe("claude");
  });
});
