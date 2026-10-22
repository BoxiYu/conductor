// Native sandbox mode: run each CLI inside its own OS-level sandbox (Seatbelt on macOS,
// Landlock/bubblewrap on Linux) and auto-approve what the sandbox allows. This is the
// approach openai/symphony uses for Codex (workspace-write + approval "never"), extended to
// the other CLIs and to read-denial of credential paths.
//
// Verified behavior (macOS, see README "Trust posture"):
//   codex  - permission profile: read everywhere except denied paths, write workspace + tmp.
//            `.git` stays read-only, so Conductor makes the commit.
//   claude - Bash sandbox with auto-allow, no unsandboxed escape; Read/Edit deny rules for the
//            same paths (the Bash sandbox does not cover Claude's own file tools).
//   grok   - project sandbox profile written into the workspace before every turn, plus
//            always-approve. The profile is kernel-enforced and loaded at start.
//   agy    - its --sandbox only restricts the terminal, not its file tools, so auto-approve
//            would let it read and write anywhere. It runs in accept-edits instead: edits stay
//            in the workspace, every shell command is refused. Use Docker for more.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, AgentKind, Config } from "./types.ts";

/** Credential locations no agent should be able to read in native mode. */
export const DEFAULT_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.docker",
  "~/.kube",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
];

/** Each CLI's own home. Agents may use their own, never another vendor's. */
export const AGENT_HOMES: Record<AgentKind, string[]> = {
  codex: ["~/.codex"],
  claude: ["~/.claude", "~/.claude.json"],
  grok: ["~/.grok"],
  agy: ["~/.gemini"],
};

/** Hosts claude's sandbox proxy allows when network is on (its allow-list starts empty). */
export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "*.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

export const GROK_PROFILE = "conductor";

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Deny list for one agent: configured paths + other vendors' homes, existing paths only. */
export function denyPathsFor(kind: AgentKind, config: Config, home = homedir(), exists = existsSync): string[] {
  const others = (Object.keys(AGENT_HOMES) as AgentKind[]).filter((k) => k !== kind).flatMap((k) => AGENT_HOMES[k]);
  const all = [...config.sandbox.denyRead, ...others].map((p) => expandHome(p, home));
  return [...new Set(all)].filter((p) => exists(p));
}

const tomlString = (s: string) => JSON.stringify(s); // TOML basic strings accept JSON escapes

export function codexSandboxArgs(config: Config, deny: string[], allowWrite: string[]): string[] {
  const fs = [
    `":root"="read"`,
    `":workspace_roots"="write"`,
    `":tmpdir"="write"`,
    ...allowWrite.map((p) => `${tomlString(p)}="write"`),
    ...deny.map((p) => `${tomlString(p)}="none"`),
  ];
  return [
    "-c",
    'approval_policy="never"',
    "-c",
    'default_permissions="conductor"',
    "-c",
    `permissions.conductor.filesystem={${fs.join(", ")}}`,
    "-c",
    `permissions.conductor.network.enabled=${config.sandbox.network}`,
  ];
}

export function claudeSandboxSettings(config: Config, deny: string[], allowWrite: string[]): Record<string, unknown> {
  const domains = config.sandbox.network
    ? config.sandbox.allowedDomains.length
      ? config.sandbox.allowedDomains
      : DEFAULT_ALLOWED_DOMAINS
    : [];
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: deny, allowWrite },
      network: { allowedDomains: domains },
    },
    permissions: {
      // In Claude permission rules an absolute path starts with `//` (a single `/` is
      // relative to the settings file).
      deny: deny.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p}/**)`]),
    },
  };
}

export function grokSandboxToml(config: Config, deny: string[], allowWrite: string[]): string {
  const list = (xs: string[]) => `[${xs.map(tomlString).join(", ")}]`;
  return [
    "# Written by Conductor before every turn; edits are overwritten.",
    `[profiles.${GROK_PROFILE}]`,
    `extends = "workspace"`,
    `restrict_network = ${!config.sandbox.network}`,
    `deny = ${list(deny)}`,
    `read_write = ${list(allowWrite)}`,
    "",
  ].join("\n");
}

/**
 * Package-manager caches inside the workspace. The sandbox blocks writes to ~/.npm and friends,
 * and opening those shared caches would let one agent poison builds on the host, so each
 * workspace gets its own (under .conductor/, which is excluded from git).
 */
export function sandboxEnv(config: Config, workspace: string): Record<string, string> {
  if (config.sandbox.mode !== "native") return {};
  const c = (name: string) => join(workspace, ".conductor", "cache", name);
  return {
    npm_config_cache: c("npm"),
    BUN_INSTALL_CACHE_DIR: c("bun"),
    YARN_CACHE_FOLDER: c("yarn"),
    PNPM_STORE_DIR: c("pnpm"),
    PIP_CACHE_DIR: c("pip"),
    UV_CACHE_DIR: c("uv"),
    GOCACHE: c("go-build"),
    GOMODCACHE: c("go-mod"),
  };
}

/** Keep sandbox files out of commits. */
function excludeFromGit(workspace: string, entry: string) {
  const gitDir = join(workspace, ".git");
  if (!existsSync(gitDir)) return;
  const exclude = join(gitDir, "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(entry)) return;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  appendFileSync(exclude, `${current.endsWith("\n") || current === "" ? "" : "\n"}${entry}\n`);
}

/**
 * Returns the agent config to use for one turn in `workspace`. In native mode this prepends
 * sandbox flags to the user's args and writes any per-workspace sandbox file the CLI needs.
 */
export function applySandbox(agent: AgentConfig, config: Config, workspace: string, home = homedir()): AgentConfig {
  if (config.sandbox.mode !== "native") return agent;
  const deny = denyPathsFor(agent.kind, config, home);
  const allowWrite = config.sandbox.allowWrite.map((p) => expandHome(p, home));
  let flags: string[];
  switch (agent.kind) {
    case "codex":
      flags = codexSandboxArgs(config, deny, allowWrite);
      break;
    case "claude":
      flags = ["--permission-mode", "acceptEdits", "--settings", JSON.stringify(claudeSandboxSettings(config, deny, allowWrite))];
      break;
    case "grok": {
      mkdirSync(join(workspace, ".grok"), { recursive: true });
      writeFileSync(join(workspace, ".grok", "sandbox.toml"), grokSandboxToml(config, deny, allowWrite));
      excludeFromGit(workspace, ".grok/");
      flags = ["--sandbox", GROK_PROFILE, "--always-approve"];
      break;
    }
    case "agy":
      flags = ["--sandbox", "--mode", "accept-edits"];
      break;
  }
  // Inside the sandbox commands are auto-approved, so per-command allow rules are not needed
  // (and for claude an allow rule would also approve an unsandboxed retry).
  return { ...agent, args: [...flags, ...agent.args], allowedCommands: agent.kind === "agy" ? agent.allowedCommands : [] };
}
