// Drives runTurn against small fake CLIs written as shell scripts.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agents/runner.ts";
import type { AgentConfig } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "conductor-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeCli(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const agent = (command: string, kind: AgentConfig["kind"] = "claude"): AgentConfig => ({
  kind,
  command,
  args: [],
  newArgs: [],
  resumeArgs: [],
  allowedCommands: [],
  maxConcurrent: 1,
  enabled: true,
});

const base = { cwd: dir, env: { PATH: process.env.PATH ?? "" }, turnTimeoutMs: 10_000, stallTimeoutMs: 0 };

describe("runTurn", () => {
  test("parses a successful claude-style stream and passes the prompt as last arg", async () => {
    const cli = fakeCli(
      "ok-claude",
      `echo '{"type":"system","subtype":"init","session_id":"S9"}'
echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"got: \${@: -1}\\"}]}}"
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"S9","usage":{"input_tokens":3,"output_tokens":2}}'`,
    );
    const r = await runTurn({ ...base, agent: agent(cli), prompt: "hello", sessionId: null });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("S9");
    expect(r.finalText).toBe("got: hello");
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  test("non-zero exit without completion is a failure; rate limit text is detected", async () => {
    const cli = fakeCli("limited", `echo "Error: usage limit reached, try again later" >&2; exit 1`);
    const r = await runTurn({ ...base, agent: agent(cli), prompt: "x", sessionId: null });
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(r.error).toContain("usage limit");
  });

  test("codex capacity failure is rate limited", async () => {
    const cli = fakeCli(
      "codex-cap",
      `echo '{"type":"thread.started","thread_id":"T"}'
echo '{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}'
exit 1`,
    );
    const r = await runTurn({ ...base, agent: agent(cli, "codex"), prompt: "x", sessionId: null });
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(r.sessionId).toBe("T");
  });

  test("stall detection kills silent processes", async () => {
    const cli = fakeCli("silent", `sleep 30`);
    const t0 = Date.now();
    const r = await runTurn({ ...base, agent: agent(cli), prompt: "x", sessionId: null, stallTimeoutMs: 300 });
    expect(r.reason).toBe("stalled");
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  test("abort signal stops the turn", async () => {
    const cli = fakeCli("slow", `while true; do echo '{"type":"noop"}'; sleep 0.1; done`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runTurn({ ...base, agent: agent(cli), prompt: "x", sessionId: null, signal: ac.signal });
    expect(r.reason).toBe("aborted");
  });

  test("missing binary fails cleanly", async () => {
    const r = await runTurn({ ...base, agent: agent(join(dir, "does-not-exist")), prompt: "x", sessionId: null });
    expect(r.ok).toBe(false);
  });

  test("child env is what we pass (no inherited tokens)", async () => {
    const cli = fakeCli(
      "env",
      `echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"token=\${GITHUB_TOKEN:-none}\\"}"`,
    );
    process.env.GITHUB_TOKEN = "secret";
    const r = await runTurn({ ...base, agent: agent(cli), prompt: "x", sessionId: null });
    delete process.env.GITHUB_TOKEN;
    expect(r.finalText).toBe("token=none");
  });
});

test("background grandchild holding stdout does not hang a finished turn", async () => {
  const cli = fakeCli(
    "bg",
    `(sleep 30) &
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"B"}'
exit 0`,
  );
  const t0 = Date.now();
  const r = await runTurn({ ...base, agent: agent(cli), prompt: "x", sessionId: null });
  expect(r.ok).toBe(true);
  expect(Date.now() - t0).toBeLessThan(4500);
});
