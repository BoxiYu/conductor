import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySandbox, claudeSandboxSettings, codexSandboxArgs, denyPathsFor, grokSandboxToml, sandboxEnv } from "../src/sandbox.ts";
import { parseWorkflow, WorkflowError } from "../src/workflow.ts";

const root = mkdtempSync(join(tmpdir(), "conductor-sbx-"));
const home = join(root, "home");
for (const d of [".ssh", ".aws", ".codex", ".claude", ".grok", ".gemini"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, ".claude.json"), "{}");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = (front = "") => parseWorkflow(`---\ntracker: {repo: a/b}\n${front}\n---\n`, "/tmp/W.md").config;

function workspace(name: string) {
  const ws = join(root, name);
  mkdirSync(join(ws, ".git", "info"), { recursive: true });
  return ws;
}

describe("sandbox config", () => {
  test("native is the default with network on and the credential deny list", () => {
    const c = cfg();
    expect(c.sandbox.mode).toBe("native");
    expect(c.sandbox.network).toBe(true);
    expect(c.sandbox.denyRead).toContain("~/.ssh");
    // In native mode agents get no permission flags from defaults; the sandbox adds them.
    expect(c.agents.claude!.args).toEqual([]);
    expect(c.agents.codex!.args).toEqual(["--skip-git-repo-check"]);
  });

  test("mode none keeps the conservative per-agent defaults", () => {
    const c = cfg("sandbox: {mode: none}");
    expect(c.agents.claude!.args).toEqual(["--permission-mode", "acceptEdits"]);
  });

  test("rejects unknown modes", () => {
    expect(() => cfg("sandbox: {mode: docker-ish}")).toThrow(WorkflowError);
  });
});

describe("deny list", () => {
  test("adds other vendors' homes, keeps the agent's own, drops missing paths", () => {
    const deny = denyPathsFor("codex", cfg(), home);
    expect(deny).toContain(join(home, ".ssh"));
    expect(deny).toContain(join(home, ".claude"));
    expect(deny).toContain(join(home, ".grok"));
    expect(deny).not.toContain(join(home, ".codex"));
    expect(deny).not.toContain(join(home, ".gnupg")); // does not exist
    expect(denyPathsFor("grok", cfg(), home)).not.toContain(join(home, ".grok"));
  });
});

describe("per-agent flags", () => {
  test("codex permission profile", () => {
    const args = codexSandboxArgs(cfg("sandbox: {network: false}"), ["/h/.ssh"], ["/cache"]);
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('default_permissions="conductor"');
    const fs = args.find((a) => a.startsWith("permissions.conductor.filesystem="))!;
    expect(fs).toContain('":root"="read"');
    expect(fs).toContain('":workspace_roots"="write"');
    expect(fs).toContain('"/h/.ssh"="none"');
    expect(fs).toContain('"/cache"="write"');
    expect(args).toContain("permissions.conductor.network.enabled=false");
  });

  test("claude sandbox settings", () => {
    const s = claudeSandboxSettings(cfg(), ["/h/.ssh"], []) as any;
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.failIfUnavailable).toBe(true);
    expect(s.sandbox.filesystem.denyRead).toEqual(["/h/.ssh"]);
    expect(s.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    expect(s.permissions.deny).toContain("Read(//h/.ssh/**)");
    const off = claudeSandboxSettings(cfg("sandbox: {network: false}"), [], []) as any;
    expect(off.sandbox.network.allowedDomains).toEqual([]);
  });

  test("grok profile", () => {
    const toml = grokSandboxToml(cfg(), ['/h/we"ird'], []);
    expect(toml).toContain("[profiles.conductor]");
    expect(toml).toContain('extends = "workspace"');
    expect(toml).toContain("restrict_network = false");
    expect(toml).toContain('deny = ["/h/we\\"ird"]');
  });
});

describe("applySandbox", () => {
  const agent = (kind: "codex" | "claude" | "grok" | "agy") => ({ ...cfg().agents[kind]!, args: ["--model", "m"] });

  test("prepends flags, keeps user args, clears allow-lists", () => {
    const ws = workspace("ws-claude");
    const a = applySandbox({ ...agent("claude"), allowedCommands: ["git commit"] }, cfg(), ws, home);
    expect(a.args[0]).toBe("--permission-mode");
    expect(a.args).toContain("--settings");
    expect(a.args.slice(-2)).toEqual(["--model", "m"]);
    expect(a.allowedCommands).toEqual([]);
  });

  test("grok writes its profile and excludes it from git", () => {
    const ws = workspace("ws-grok");
    const a = applySandbox(agent("grok"), cfg(), ws, home);
    expect(a.args.slice(0, 3)).toEqual(["--sandbox", "conductor", "--always-approve"]);
    expect(readFileSync(join(ws, ".grok", "sandbox.toml"), "utf8")).toContain(join(home, ".ssh"));
    // Rewritten every turn: tampering is undone.
    writeFileSync(join(ws, ".grok", "sandbox.toml"), "[profiles.conductor]\nextends = \"devbox\"\n");
    applySandbox(agent("grok"), cfg(), ws, home);
    expect(readFileSync(join(ws, ".grok", "sandbox.toml"), "utf8")).toContain('extends = "workspace"');
    applySandbox(agent("grok"), cfg(), ws, home);
    const exclude = readFileSync(join(ws, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".grok/")).toHaveLength(1);
  });

  test("agy stays in accept-edits (its sandbox does not cover file tools)", () => {
    const a = applySandbox(agent("agy"), cfg(), workspace("ws-agy"), home);
    expect(a.args.slice(0, 3)).toEqual(["--sandbox", "--mode", "accept-edits"]);
    expect(a.args).not.toContain("--dangerously-skip-permissions");
  });

  test("mode none returns the agent unchanged", () => {
    const c = cfg("sandbox: {mode: none}");
    const a = c.agents.codex!;
    const ws = workspace("ws-none");
    expect(applySandbox(a, c, ws, home)).toBe(a);
    expect(existsSync(join(ws, ".grok"))).toBe(false);
  });
});

describe("sandboxEnv", () => {
  test("points package caches into the workspace in native mode only", () => {
    const env = sandboxEnv(cfg(), "/w/x");
    expect(env.npm_config_cache).toBe("/w/x/.conductor/cache/npm");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/w/x/.conductor/cache/bun");
    expect(sandboxEnv(cfg("sandbox: {mode: none}"), "/w/x")).toEqual({});
  });
});
