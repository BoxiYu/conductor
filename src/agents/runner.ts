// Runs one agent turn as a subprocess and turns its NDJSON stream into a TurnResult.

import type { AgentConfig, AgentEvent, TurnResult } from "../types.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { ADAPTERS, looksRateLimited, newParseState } from "./adapters.ts";

export interface RunTurnOptions {
  agent: AgentConfig;
  prompt: string;
  sessionId: string | null;
  cwd: string;
  env: Record<string, string>;
  turnTimeoutMs: number;
  /** Kill the turn when no output arrives for this long. 0 disables. */
  stallTimeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

const MAX_LINE = 10 * 1024 * 1024;

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const adapter = ADAPTERS[opts.agent.kind];
  const argv = adapter.argv(opts.agent, opts.prompt, opts.sessionId);
  const st = newParseState();
  st.sessionId = opts.sessionId;

  let child: ChildProcess;
  try {
    // Own process group, so tool subprocesses the agent started die with it.
    child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (err) {
    return fail(st, `cannot start ${argv[0]}: ${(err as Error).message}`, null, "failed");
  }

  let spawnError = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("error", (err) => {
      spawnError = err.message;
      resolveExit(null);
    });
    child.once("close", (code) => resolveExit(code));
    // If the agent exits but a background child keeps stdout open, reap the group shortly after.
    child.once("exit", () => setTimeout(() => killGroup("SIGKILL"), 2000).unref?.());
  });

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };

  let reason: TurnResult["reason"] | null = null;
  const kill = (why: TurnResult["reason"]) => {
    if (reason) return;
    reason = why;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 5000).unref?.();
  };

  let lastOutput = Date.now();
  const turnTimer = setTimeout(() => kill("timeout"), opts.turnTimeoutMs);
  const stallTimer =
    opts.stallTimeoutMs > 0
      ? setInterval(() => {
          if (Date.now() - lastOutput > opts.stallTimeoutMs) kill("stalled");
        }, Math.min(5000, opts.stallTimeoutMs))
      : null;
  const onAbort = () => kill("aborted");
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort);

  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {}
  };

  let rateLimitHint = "";
  const handleLine = (line: string) => {
    lastOutput = Date.now();
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > MAX_LINE) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      emit({ type: "other", raw: trimmed.slice(0, 500) });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    for (const e of adapter.parse(parsed as Record<string, unknown>, st)) {
      if (e.type === "rate_limit") rateLimitHint = e.message;
      emit(e);
    }
  };

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lastOutput = Date.now();
    stderrBuf = (stderrBuf + chunk).slice(-8000);
  });
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });

  const exitCode = await exited;
  if (buf) handleLine(buf);
  clearTimeout(turnTimer);
  if (stallTimer) clearInterval(stallTimer);
  opts.signal?.removeEventListener("abort", onAbort);
  // Make sure nothing from this turn outlives it.
  killGroup("SIGKILL");
  if (spawnError) return fail(st, `cannot start ${argv[0]}: ${spawnError}`, null, "failed");

  const stderrTail = stderrBuf.slice(-2000);
  if (reason) return fail(st, `turn ${reason}`, exitCode, reason);

  const permissionDenied = detectPermissionDenial(stderrBuf);

  if (st.signal?.ok && exitCode === 0) {
    return {
      ok: true,
      sessionId: st.sessionId,
      finalText: st.finalText,
      usage: st.usage,
      error: null,
      rateLimited: false,
      permissionDenied,
      exitCode,
      reason: "completed",
    };
  }
  const error =
    st.signal?.error ||
    st.buffer ||
    (st.signal?.ok ? `process exited with code ${exitCode}` : `no completion signal (exit ${exitCode})`) +
      (stderrTail ? `: ${stderrTail.slice(-500)}` : "");
  const result = fail(st, error, exitCode, "failed");
  result.permissionDenied = permissionDenied;
  result.rateLimited = !permissionDenied && (Boolean(rateLimitHint) || looksRateLimited(error));
  return result;
}

/**
 * Headless CLIs report tool calls they could not get approval for on stderr.
 * grok: "permission required: Execute `cmd` was not run, as a headless run cannot ask for approval"
 * agy:  "... a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied."
 */
export function detectPermissionDenial(stderr: string): string | null {
  const grok = [...stderr.matchAll(/permission required: (.+?) was not run/g)].map((m) => m[1]!.trim());
  if (grok.length) return grok.slice(-3).join("; ").slice(0, 600);
  if (/headless mode cannot prompt for, so it was auto-denied/.test(stderr)) return "a shell command (not on the allowed list)";
  return null;
}

function fail(st: ReturnType<typeof newParseState>, error: string, exitCode: number | null, reason: TurnResult["reason"]): TurnResult {
  return {
    ok: false,
    sessionId: st.sessionId,
    finalText: st.finalText,
    usage: st.usage,
    error,
    rateLimited: looksRateLimited(error),
    permissionDenied: null,
    exitCode,
    reason,
  };
}
