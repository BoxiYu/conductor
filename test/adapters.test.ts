// Fixtures mirror the real NDJSON shapes observed from each CLI (trimmed to relevant fields).

import { describe, expect, test } from "bun:test";
import { ADAPTERS, looksRateLimited, newParseState } from "../src/agents/adapters.ts";
import type { AgentConfig, AgentKind } from "../src/types.ts";

const cfg = (kind: AgentKind, args: string[] = []): AgentConfig => ({
  kind,
  command: kind,
  args,
  newArgs: [],
  resumeArgs: [],
  allowedCommands: [],
  maxConcurrent: 1,
  enabled: true,
});

function feed(kind: AgentKind, lines: object[]) {
  const st = newParseState();
  const events = lines.flatMap((l) => ADAPTERS[kind].parse(l as Record<string, unknown>, st));
  return { st, events };
}

describe("codex adapter", () => {
  test("argv for new and resumed sessions", () => {
    expect(ADAPTERS.codex.argv(cfg("codex", ["-m", "x"]), "do it", null)).toEqual(["codex", "exec", "--json", "-m", "x", "do it"]);
    expect(ADAPTERS.codex.argv(cfg("codex"), "more", "T1")).toEqual(["codex", "exec", "resume", "--json", "T1", "more"]);
  });

  test("success", () => {
    const { st, events } = feed("codex", [
      { type: "thread.started", thread_id: "T1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls" } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "All done" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 7 } },
    ]);
    expect(st.sessionId).toBe("T1");
    expect(st.finalText).toBe("All done");
    expect(st.signal).toEqual({ ok: true });
    expect(st.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
    expect(events.some((e) => e.type === "tool")).toBe(true);
  });

  test("capacity failure", () => {
    const { st } = feed("codex", [
      { type: "thread.started", thread_id: "T1" },
      { type: "error", message: "Selected model is at capacity. Please try a different model." },
      { type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } },
    ]);
    expect(st.signal?.ok).toBe(false);
    expect(looksRateLimited(st.signal!.error!)).toBe(true);
  });
});

describe("claude adapter", () => {
  test("argv puts prompt after --", () => {
    const argv = ADAPTERS.claude.argv(cfg("claude", ["--allowedTools", "Read", "Edit"]), "fix", "S1");
    expect(argv.slice(0, 7)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose", "--resume", "S1"]);
    expect(argv.slice(-2)).toEqual(["--", "fix"]);
  });

  test("allowed commands become Bash permission rules before the prompt", () => {
    const c = { ...cfg("claude", ["--permission-mode", "acceptEdits"]), allowedCommands: ["git commit", "bun test"] };
    const argv = ADAPTERS.claude.argv(c, "fix", null);
    expect(argv.slice(5, 8)).toEqual(["--allowedTools", "Bash(git commit:*)", "Bash(bun test:*)"]);
    expect(argv.slice(-2)).toEqual(["--", "fix"]);
  });

  test("success and rate limit event", () => {
    const { st, events } = feed("claude", [
      { type: "system", subtype: "init", session_id: "S1" },
      { type: "assistant", session_id: "S1", message: { content: [{ type: "tool_use", name: "Edit" }, { type: "text", text: "Done." }] } },
      { type: "rate_limit_event", session_id: "S1", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } },
      { type: "result", subtype: "success", is_error: false, session_id: "S1", result: "Done.", usage: { input_tokens: 6, cache_read_input_tokens: 10, output_tokens: 3 } },
    ]);
    expect(st.sessionId).toBe("S1");
    expect(st.signal).toEqual({ ok: true });
    expect(st.usage).toEqual({ inputTokens: 16, outputTokens: 3 });
    expect(events.find((e) => e.type === "rate_limit")).toBeTruthy();
  });

  test("error result", () => {
    const { st } = feed("claude", [{ type: "result", subtype: "error_max_turns", is_error: true, session_id: "S1" }]);
    expect(st.signal).toEqual({ ok: false, error: "error_max_turns" });
  });
});

describe("agy adapter", () => {
  test("argv", () => {
    expect(ADAPTERS.agy.argv(cfg("agy"), "go", "C1")).toEqual(["agy", "--output-format", "stream-json", "--conversation", "C1", "-p", "go"]);
  });

  test("streams deltas and reads result", () => {
    const { st } = feed("agy", [
      { event: "init", conversation_id: "C1" },
      { event: "step_update", step_update: { conversation_id: "C1", step_index: 0, state: "DONE", step_type: "user_input" } },
      { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "DO" } },
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "NE\n" } },
      { event: "result", result: { conversation_id: "C1", status: "SUCCESS", response: "DONE\n", usage: { input_tokens: 12, output_tokens: 5 } } },
    ]);
    expect(st.sessionId).toBe("C1");
    expect(st.finalText).toBe("DONE");
    expect(st.signal).toEqual({ ok: true });
    expect(st.usage.outputTokens).toBe(5);
  });

  test("non-success status fails", () => {
    const { st } = feed("agy", [{ event: "result", result: { status: "ERROR", response: "quota exceeded" } }]);
    expect(st.signal?.ok).toBe(false);
    expect(looksRateLimited(st.signal!.error!)).toBe(true);
  });
});

describe("grok adapter", () => {
  test("argv", () => {
    expect(ADAPTERS.grok.argv(cfg("grok", ["--always-approve"]), "go", null)).toEqual([
      "grok",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "-p",
      "go",
    ]);
  });

  test("allowed commands become --allow rules", () => {
    const c = { ...cfg("grok", ["--permission-mode", "acceptEdits"]), allowedCommands: ["git commit", "bun test"] };
    expect(ADAPTERS.grok.argv(c, "go", "G1")).toEqual([
      "grok", "--output-format", "streaming-json",
      "--allow", "Bash(git commit:*)", "--allow", "Bash(bun test:*)",
      "--resume", "G1", "--permission-mode", "acceptEdits", "-p", "go",
    ]);
  });

  test("text + end", () => {
    const { st } = feed("grok", [
      { type: "available_commands", tools: ["read_file"] },
      { type: "text", data: "DO" },
      { type: "text", data: "NE" },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 3 } },
      { type: "end", stopReason: "end_turn", sessionId: "G1", usage: {} },
    ]);
    expect(st.sessionId).toBe("G1");
    expect(st.finalText).toBe("DONE");
    expect(st.signal).toEqual({ ok: true });
  });

  test("refusal stop reason fails", () => {
    const { st } = feed("grok", [{ type: "end", stopReason: "refusal", sessionId: "G1" }]);
    expect(st.signal?.ok).toBe(false);
  });
});
