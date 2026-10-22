// Loads WORKFLOW.md: YAML front matter (runtime config) + Liquid body (per-issue prompt).

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Liquid } from "liquidjs";
import YAML from "yaml";
import type { AgentConfig, AgentKind, Config, Workflow } from "./types.ts";
import { DEFAULT_DENY_READ } from "./sandbox.ts";

export class WorkflowError extends Error {}

const AGENT_KINDS: AgentKind[] = ["codex", "claude", "agy", "grok"];

/** Read-only and local-commit git commands. Push stays with Conductor. */
export const DEFAULT_ALLOWED_COMMANDS = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "git add",
  "git commit",
  // read-only helpers agents reach for constantly
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "grep",
];

/**
 * Default per-agent flags for `sandbox.mode: none`. They keep each CLI inside the workspace and
 * auto-accept file edits, but do not hand out unrestricted shell access. In native mode the
 * sandbox module adds the permission flags (see src/sandbox.ts), so only these remain.
 */
const NATIVE_AGENT_ARGS: Record<AgentKind, string[]> = {
  codex: ["--skip-git-repo-check"],
  claude: [],
  agy: [],
  grok: [],
};

const DEFAULT_AGENT_ARGS: Record<AgentKind, string[]> = {
  codex: ["--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'],
  claude: ["--permission-mode", "acceptEdits"],
  agy: ["--sandbox", "--mode", "accept-edits"],
  grok: ["--permission-mode", "acceptEdits"],
};

export function splitFrontMatter(text: string): { front: string; body: string } {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return { front: "", body: normalized };
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) throw new WorkflowError("WORKFLOW.md front matter is not closed with ---");
  return { front: match[1] ?? "", body: normalized.slice(match[0].length) };
}

export function loadWorkflow(path: string, env: NodeJS.ProcessEnv = process.env): Workflow {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    throw new WorkflowError(`cannot read workflow file ${abs}: ${(err as Error).message}`);
  }
  return parseWorkflow(text, abs, env);
}

export function parseWorkflow(text: string, path: string, env: NodeJS.ProcessEnv = process.env): Workflow {
  const { front, body } = splitFrontMatter(text);
  let raw: unknown;
  try {
    raw = front.trim() ? YAML.parse(front) : {};
  } catch (err) {
    throw new WorkflowError(`invalid YAML front matter: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowError("front matter must be a YAML mapping");
  }
  const config = buildConfig(raw as Record<string, unknown>, dirname(path), env);
  const promptTemplate = body.trim() || "You are working on GitHub issue {{ issue.identifier }}: {{ issue.title }}.";
  // Fail fast on template syntax errors instead of at first dispatch.
  liquid.parse(promptTemplate);
  return { path, config, promptTemplate };
}

// ---------- config ----------

type Obj = Record<string, unknown>;

function obj(v: unknown, name: string): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new WorkflowError(`\`${name}\` must be a mapping`);
  return v as Obj;
}

function str(v: unknown, fallback: string, env: NodeJS.ProcessEnv): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") return String(v);
  return resolveVar(v, env);
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function int(v: unknown, fallback: number, name: string, { min = 1 } = {}): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min) throw new WorkflowError(`\`${name}\` must be an integer >= ${min}`);
  return n;
}

function strList(v: unknown, fallback: string[], name: string): string[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) throw new WorkflowError(`\`${name}\` must be a list`);
  return v.map((x) => String(x));
}

/** `$NAME` as the whole value means "read from the environment". */
export function resolveVar(value: string, env: NodeJS.ProcessEnv): string {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  if (!m) return value;
  return env[m[1]!] ?? "";
}

export function expandPath(p: string, baseDir: string): string {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(baseDir, out);
}

function buildConfig(raw: Obj, baseDir: string, env: NodeJS.ProcessEnv): Config {
  const tracker = obj(raw.tracker, "tracker");
  const polling = obj(raw.polling, "polling");
  const workspace = obj(raw.workspace, "workspace");
  const hooks = obj(raw.hooks, "hooks");
  const agent = obj(raw.agent, "agent");
  const routing = obj(raw.routing, "routing");
  const handoff = obj(raw.handoff, "handoff");
  const verify = obj(raw.verify, "verify");
  const sandbox = obj(raw.sandbox, "sandbox");
  const sandboxMode = str(sandbox.mode, "native", env);
  if (sandboxMode !== "native" && sandboxMode !== "none") {
    throw new WorkflowError(`sandbox.mode must be native or none (got ${sandboxMode})`);
  }
  const verifyCommands = strList(verify.commands, [], "verify.commands").map((c) => c.trim()).filter(Boolean);
  const server = obj(raw.server, "server");

  const kind = str(tracker.kind, "github", env);
  if (kind !== "github" && kind !== "memory") throw new WorkflowError(`unsupported tracker.kind: ${kind}`);

  const agents = buildAgents(obj(raw.agents, "agents"), env, verifyCommands, sandboxMode === "native" ? NATIVE_AGENT_ARGS : DEFAULT_AGENT_ARGS);
  const defaultRoute = strList(routing.default, Object.keys(agents).filter((k) => agents[k]!.enabled), "routing.default");
  for (const name of defaultRoute) {
    if (!agents[name]) throw new WorkflowError(`routing.default references unknown agent \`${name}\``);
  }

  const port = server.port === undefined || server.port === null ? null : int(server.port, 0, "server.port", { min: 0 });

  return {
    tracker: {
      kind,
      repo: str(tracker.repo, "", env),
      tokenEnv: str(tracker.token_env, "GITHUB_TOKEN", env),
      requiredLabels: strList(tracker.required_labels, ["conductor"], "tracker.required_labels"),
      statePrefix: str(tracker.state_label_prefix, "state:", env),
      activeStates: strList(tracker.active_states, ["Todo", "In Progress", "Rework"], "tracker.active_states"),
      terminalStates: strList(tracker.terminal_states, ["Closed"], "tracker.terminal_states"),
      defaultState: str(tracker.default_state, "Todo", env),
      inProgressState: str(tracker.in_progress_state, "In Progress", env),
      reviewState: str(tracker.review_state, "Human Review", env),
      blockedState: str(tracker.blocked_state, "Blocked", env),
    },
    polling: { intervalMs: int(polling.interval_ms, 30_000, "polling.interval_ms") },
    workspace: {
      root: expandPath(str(workspace.root, join(tmpdir(), "conductor_workspaces"), env), baseDir),
      branchPrefix: str(workspace.branch_prefix, "conductor/", env),
    },
    hooks: {
      afterCreate: optStr(hooks.after_create),
      beforeRun: optStr(hooks.before_run),
      afterRun: optStr(hooks.after_run),
      beforeRemove: optStr(hooks.before_remove),
      timeoutMs: int(hooks.timeout_ms, 120_000, "hooks.timeout_ms"),
    },
    agent: {
      maxConcurrentAgents: int(agent.max_concurrent_agents, 4, "agent.max_concurrent_agents"),
      maxTurns: int(agent.max_turns, 10, "agent.max_turns"),
      maxAttempts: int(agent.max_attempts, 5, "agent.max_attempts"),
      maxRetryBackoffMs: int(agent.max_retry_backoff_ms, 300_000, "agent.max_retry_backoff_ms"),
      turnTimeoutMs: int(agent.turn_timeout_ms, 3_600_000, "agent.turn_timeout_ms"),
      stallTimeoutMs: int(agent.stall_timeout_ms, 600_000, "agent.stall_timeout_ms", { min: 0 }),
      rateLimitCooldownMs: int(agent.rate_limit_cooldown_ms, 900_000, "agent.rate_limit_cooldown_ms", { min: 0 }),
    },
    routing: {
      default: defaultRoute,
      labelPrefix: str(routing.label_prefix, "agent:", env),
    },
    handoff: {
      openPullRequest: handoff.open_pull_request === undefined ? true : Boolean(handoff.open_pull_request),
      draft: Boolean(handoff.draft),
    },
    sandbox: {
      mode: sandboxMode,
      network: sandbox.network === undefined ? true : Boolean(sandbox.network),
      allowedDomains: strList(sandbox.allowed_domains, [], "sandbox.allowed_domains"),
      denyRead: strList(sandbox.deny_read, DEFAULT_DENY_READ, "sandbox.deny_read"),
      allowWrite: strList(sandbox.allow_write, [], "sandbox.allow_write"),
    },
    verify: { commands: verifyCommands },
    server: { port },
    agents,
  };
}

function buildAgents(
  raw: Obj,
  env: NodeJS.ProcessEnv,
  verifyCommands: string[],
  defaultArgs: Record<AgentKind, string[]>,
): Record<string, AgentConfig> {
  const out: Record<string, AgentConfig> = {};
  // Built-in agents are always defined; WORKFLOW.md can tune or disable them.
  const names = new Set<string>([...AGENT_KINDS, ...Object.keys(raw)]);
  for (const name of names) {
    const a = obj(raw[name], `agents.${name}`);
    const kind = str(a.kind, name, env) as AgentKind;
    if (!AGENT_KINDS.includes(kind)) {
      throw new WorkflowError(`agents.${name}.kind must be one of ${AGENT_KINDS.join(", ")}`);
    }
    out[name] = {
      kind,
      command: str(a.command, kind, env),
      args: strList(a.args, defaultArgs[kind], `agents.${name}.args`),
      newArgs: strList(a.new_args, [], `agents.${name}.new_args`),
      resumeArgs: strList(a.resume_args, [], `agents.${name}.resume_args`),
      // Verify commands are always allowed on top of the (overridable) base list.
      allowedCommands: [
        ...new Set([
          ...strList(a.allowed_commands, DEFAULT_ALLOWED_COMMANDS, `agents.${name}.allowed_commands`),
          ...verifyCommands,
        ]),
      ],
      maxConcurrent: int(a.max_concurrent, 2, `agents.${name}.max_concurrent`),
      enabled: a.enabled === undefined ? true : Boolean(a.enabled),
    };
  }
  return out;
}

/** Returns a list of problems that block dispatch (empty means OK). */
export function validateForDispatch(config: Config): string[] {
  const problems: string[] = [];
  if (config.tracker.kind === "github" && !/^[\w.-]+\/[\w.-]+$/.test(config.tracker.repo)) {
    problems.push("tracker.repo must be set to owner/name");
  }
  if (config.routing.default.length === 0) problems.push("routing.default has no agents");
  if (!Object.values(config.agents).some((a) => a.enabled)) problems.push("no agents are enabled");
  return problems;
}

// ---------- prompt ----------

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export interface PromptInput {
  issue: Record<string, unknown>;
  attempt: number | null;
  agent: string;
  feedback: string;
}

export async function renderPrompt(template: string, input: PromptInput): Promise<string> {
  return liquid.parseAndRender(template, input as unknown as Record<string, unknown>);
}
