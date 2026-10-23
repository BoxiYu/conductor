// Shared domain types. Names follow the Symphony spec where it makes sense.

export interface Issue {
  /** Stable tracker id (for GitHub: the issue number as a string). */
  id: string;
  /** Human identifier used for logs, branches and workspace names, e.g. "conductor-12". */
  identifier: string;
  number: number;
  /** Goes into the branch name, e.g. "12" (GitHub) or "py-14" (Linear, so its GitHub integration links the PR). */
  branchKey: string;
  title: string;
  description: string | null;
  /** Derived workflow state, e.g. "Todo", "In Progress", "Human Review", "Rework", "Closed". */
  state: string;
  labels: string[];
  url: string;
  priority: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentConfig {
  /** Which adapter speaks to this CLI: codex | claude | agy | grok. */
  kind: AgentKind;
  /** Executable to launch. Defaults to the kind name. */
  command: string;
  /** Extra CLI args appended to every invocation (permissions, sandbox, model ...). */
  args: string[];
  /** Extra args only for the first turn of a session. */
  newArgs: string[];
  /** Extra args only for resumed turns. */
  resumeArgs: string[];
  /**
   * Shell commands the agent may run without approval, as prefixes (e.g. "git commit").
   * claude and grok get them as `Bash(<cmd>:*)` permission rules. agy only honors user-level
   * settings, and codex relies on its sandbox, so neither uses this list.
   */
  allowedCommands: string[];
  maxConcurrent: number;
  enabled: boolean;
}

export type AgentKind = "codex" | "claude" | "agy" | "grok";

export interface Config {
  tracker: {
    kind: "github" | "linear" | "memory";
    /**
     * "owner/name" of the GitHub repository branches and PRs go to. For `github` its issues are
     * also the work queue.
     */
    repo: string;
    /** Environment variable holding the tracker token (GitHub: falls back to `gh auth token`). */
    tokenEnv: string;
    /** GitHub token variable when the tracker is not GitHub (falls back to `gh auth token`). */
    githubTokenEnv: string;
    /** Linear: team key, e.g. "PY". */
    team: string;
    /** Linear: only issues in this project (name), empty = whole team. */
    project: string;
    requiredLabels: string[];
    /** Labels of the form `${statePrefix}<state>` carry workflow state. */
    statePrefix: string;
    activeStates: string[];
    terminalStates: string[];
    /** State an open issue has when it carries no state label. */
    defaultState: string;
    inProgressState: string;
    reviewState: string;
    blockedState: string;
  };
  polling: { intervalMs: number };
  workspace: { root: string; branchPrefix: string };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxAttempts: number;
    maxRetryBackoffMs: number;
    turnTimeoutMs: number;
    stallTimeoutMs: number;
    /** How long an agent is skipped after it reports a rate limit / capacity error. */
    rateLimitCooldownMs: number;
  };
  routing: {
    /** Agents tried in order for issues without an `agent:<name>` label. */
    default: string[];
    labelPrefix: string;
  };
  handoff: {
    /** Push the branch and open a PR when the agent reports done. */
    openPullRequest: boolean;
    draft: boolean;
  };
  sandbox: {
    /**
     * native: each CLI's own OS sandbox, auto-approving what it allows (default).
     * none: no flags added; `agents.<name>.args` decide everything (e.g. inside Docker).
     */
    mode: "native" | "none";
    /** Allow network for commands the agent runs. */
    network: boolean;
    /** Hosts claude's sandbox proxy lets through when network is on (empty = built-in list). */
    allowedDomains: string[];
    /** Paths agents may not read (or write). Other vendors' CLI homes are always added. */
    denyRead: string[];
    /** Extra writable paths besides the workspace and temp dirs (e.g. a package cache). */
    allowWrite: string[];
  };
  /** Commands the agent should run to verify its work, e.g. ["bun test"]. */
  verify: { commands: string[] };
  server: { port: number | null };
  agents: Record<string, AgentConfig>;
}

export interface Workflow {
  path: string;
  config: Config;
  promptTemplate: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "usage"; usage: Usage }
  | { type: "rate_limit"; message: string }
  | { type: "other"; raw: unknown };

export interface TurnResult {
  ok: boolean;
  sessionId: string | null;
  /** Last assistant text, if any. */
  finalText: string;
  usage: Usage;
  error: string | null;
  /** Error looks like quota / rate limit / capacity, so another agent should be tried. */
  rateLimited: boolean;
  /** The CLI refused a tool call it could not get approval for (headless). The session can continue. */
  permissionDenied: string | null;
  exitCode: number | null;
  reason: "completed" | "failed" | "timeout" | "stalled" | "aborted";
}

/** What the agent writes to `.conductor/result.json` when it finishes a task. */
export interface AgentReport {
  status: "done" | "blocked";
  summary: string;
  prTitle?: string;
}
