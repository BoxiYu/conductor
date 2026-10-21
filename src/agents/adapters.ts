// One adapter per CLI. Each knows how to build argv for a new or resumed session and how to read
// that CLI's NDJSON stream. Formats were verified against: codex-cli 0.163, Claude Code 2.1,
// agy 1.4, grok 1.0.

import type { AgentConfig, AgentEvent, AgentKind, Usage } from "../types.ts";

export interface TurnSignal {
  ok: boolean;
  error?: string;
}

export interface ParseState {
  sessionId: string | null;
  finalText: string;
  usage: Usage;
  signal: TurnSignal | null;
  /** Scratch space for adapters that stream text deltas. */
  buffer: string;
}

export interface AgentAdapter {
  kind: AgentKind;
  argv(cfg: AgentConfig, prompt: string, sessionId: string | null): string[];
  /** Consume one parsed JSON line; mutate state and return events for observers. */
  parse(line: Record<string, unknown>, state: ParseState): AgentEvent[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export const newParseState = (): ParseState => ({
  sessionId: null,
  finalText: "",
  usage: { inputTokens: 0, outputTokens: 0 },
  signal: null,
  buffer: "",
});

// ---------- codex: `codex exec --json` / `codex exec resume --json <id>` ----------

export const codexAdapter: AgentAdapter = {
  kind: "codex",
  argv(cfg, prompt, sessionId) {
    return sessionId
      ? [cfg.command, "exec", "resume", "--json", ...cfg.args, ...cfg.resumeArgs, sessionId, prompt]
      : [cfg.command, "exec", "--json", ...cfg.args, ...cfg.newArgs, prompt];
  },
  parse(line, st) {
    const type = s(line.type);
    switch (type) {
      case "thread.started":
        st.sessionId = s(line.thread_id) || st.sessionId;
        return st.sessionId ? [{ type: "session", sessionId: st.sessionId }] : [];
      case "item.completed":
      case "item.started": {
        const item = o(line.item);
        if (item.type === "agent_message" && type === "item.completed") {
          st.finalText = s(item.text);
          return [{ type: "text", text: st.finalText }];
        }
        if (item.type === "command_execution" && type === "item.started") {
          return [{ type: "tool", name: "shell", detail: s(item.command).slice(0, 200) }];
        }
        if (item.type === "file_change" && type === "item.completed") return [{ type: "tool", name: "file_change" }];
        return [];
      }
      case "turn.completed": {
        const u = o(line.usage);
        st.usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
        st.signal = { ok: true };
        return [{ type: "usage", usage: st.usage }];
      }
      case "turn.failed":
        st.signal = { ok: false, error: s(o(line.error).message) || "turn failed" };
        return [];
      case "error":
        // Top-level errors precede turn.failed; keep the message in case no turn.failed arrives.
        if (!st.signal) st.buffer = s(line.message);
        return [];
      default:
        return [{ type: "other", raw: line }];
    }
  },
};

// ---------- claude: `claude -p --output-format stream-json --verbose [--resume id]` ----------

export function claudeAllowedTools(commands: string[]): string[] {
  return commands.length ? ["--allowedTools", ...commands.map((c) => `Bash(${c}:*)`)] : [];
}

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  argv(cfg, prompt, sessionId) {
    const base = [cfg.command, "-p", "--output-format", "stream-json", "--verbose", ...claudeAllowedTools(cfg.allowedCommands)];
    return sessionId
      ? [...base, "--resume", sessionId, ...cfg.args, ...cfg.resumeArgs, "--", prompt]
      : [...base, ...cfg.args, ...cfg.newArgs, "--", prompt];
  },
  parse(line, st) {
    const type = s(line.type);
    if (s(line.session_id)) st.sessionId = s(line.session_id);
    if (type === "system" && line.subtype === "init") {
      return st.sessionId ? [{ type: "session", sessionId: st.sessionId }] : [];
    }
    if (type === "assistant") {
      const events: AgentEvent[] = [];
      const content = o(line.message).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = o(block);
          if (b.type === "text" && s(b.text)) {
            st.finalText = s(b.text);
            events.push({ type: "text", text: st.finalText });
          } else if (b.type === "tool_use") {
            events.push({ type: "tool", name: s(b.name) });
          }
        }
      }
      return events;
    }
    if (type === "rate_limit_event") {
      const info = o(line.rate_limit_info);
      if (info.status && info.status !== "allowed") {
        return [{ type: "rate_limit", message: `claude ${s(info.rateLimitType)} limit: ${s(info.status)}` }];
      }
      return [];
    }
    if (type === "result") {
      const u = o(line.usage);
      st.usage = {
        inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        outputTokens: num(u.output_tokens),
      };
      if (s(line.result)) st.finalText = s(line.result);
      const ok = line.subtype === "success" && line.is_error !== true;
      st.signal = ok ? { ok } : { ok, error: s(line.result) || s(line.subtype) || "claude run failed" };
      return [{ type: "usage", usage: st.usage }];
    }
    return [{ type: "other", raw: line }];
  },
};

// ---------- agy: `agy -p <prompt> --output-format stream-json [--conversation id]` ----------

export const agyAdapter: AgentAdapter = {
  kind: "agy",
  argv(cfg, prompt, sessionId) {
    const base = [cfg.command, "--output-format", "stream-json"];
    return sessionId
      ? [...base, "--conversation", sessionId, ...cfg.args, ...cfg.resumeArgs, "-p", prompt]
      : [...base, ...cfg.args, ...cfg.newArgs, "-p", prompt];
  },
  parse(line, st) {
    const event = s(line.event);
    if (event === "init") {
      st.sessionId = s(line.conversation_id) || st.sessionId;
      return st.sessionId ? [{ type: "session", sessionId: st.sessionId }] : [];
    }
    if (event === "step_update") {
      const step = o(line.step_update);
      if (step.step_type === "agent_response") {
        st.buffer += s(step.text_delta);
        if (step.state === "DONE") {
          if (st.buffer.trim()) st.finalText = st.buffer.trim();
          st.buffer = "";
          return [{ type: "text", text: st.finalText }];
        }
        return [];
      }
      if (step.state === "ACTIVE" && step.step_type && step.step_type !== "user_input") {
        return [{ type: "tool", name: s(step.step_type) }];
      }
      return [];
    }
    if (event === "result") {
      const r = o(line.result);
      st.sessionId = s(r.conversation_id) || st.sessionId;
      const u = o(r.usage);
      st.usage = { inputTokens: num(u.input_tokens) + num(u.cache_read_tokens), outputTokens: num(u.output_tokens) };
      if (s(r.response).trim()) st.finalText = s(r.response).trim();
      const ok = s(r.status).toUpperCase() === "SUCCESS";
      st.signal = ok ? { ok } : { ok, error: s(r.error) || s(r.response) || `agy status ${s(r.status)}` };
      return [{ type: "usage", usage: st.usage }];
    }
    return [{ type: "other", raw: line }];
  },
};

// ---------- grok: `grok -p <prompt> --output-format streaming-json [--resume id]` ----------

export const grokAdapter: AgentAdapter = {
  kind: "grok",
  argv(cfg, prompt, sessionId) {
    const base = [cfg.command, "--output-format", "streaming-json"];
    return sessionId
      ? [...base, "--resume", sessionId, ...cfg.args, ...cfg.resumeArgs, "-p", prompt]
      : [...base, ...cfg.args, ...cfg.newArgs, "-p", prompt];
  },
  parse(line, st) {
    const type = s(line.type);
    if (type === "text") {
      st.buffer += s(line.data);
      return [];
    }
    if (type === "tool_call" || type === "tool_use") {
      return [{ type: "tool", name: s(line.name) || s(o(line.data).name) || "tool" }];
    }
    if (type === "usage") {
      const u = o(line.usage);
      st.usage = { inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens), outputTokens: num(u.output_tokens) };
      return [{ type: "usage", usage: st.usage }];
    }
    if (type === "error") {
      st.signal = { ok: false, error: s(line.message) || s(line.data) || "grok error" };
      return [];
    }
    if (type === "end") {
      st.sessionId = s(line.sessionId) || st.sessionId;
      if (st.buffer.trim()) st.finalText = st.buffer.trim();
      const stop = s(line.stopReason);
      const ok = stop === "end_turn" || stop === "max_turns" || stop === "";
      st.signal = ok ? { ok } : { ok, error: `grok stopped: ${stop}` };
      const events: AgentEvent[] = [{ type: "text", text: st.finalText }];
      if (st.sessionId) events.push({ type: "session", sessionId: st.sessionId });
      return events;
    }
    return type === "available_commands" ? [] : [{ type: "other", raw: line }];
  },
};

export const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  agy: agyAdapter,
  grok: grokAdapter,
};

const RATE_LIMIT_RE = /(rate.?limit|at capacity|quota|usage limit|too many requests|\b429\b|overloaded|credit balance|limit reached)/i;

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}
