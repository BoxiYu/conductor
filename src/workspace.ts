// Per-issue workspaces: <root>/<sanitized identifier>. Preserved across runs, removed when the
// issue reaches a terminal state.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AgentReport, Config, Issue } from "./types.ts";
import { log } from "./log.ts";

export const STATE_DIR = ".conductor";

export function sanitizeIdentifier(identifier: string): string {
  const cleaned = identifier.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "_";
}

export function workspacePath(root: string, identifier: string): string {
  const absRoot = resolve(root);
  const path = resolve(absRoot, sanitizeIdentifier(identifier));
  if (!path.startsWith(absRoot + sep)) throw new Error(`workspace path escapes root: ${path}`);
  return path;
}

export function branchName(config: Config, issue: Issue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${config.workspace.branchPrefix}${issue.number}${slug ? `-${slug}` : ""}`;
}

/** Environment for agent child processes: tracker / forge credentials removed. */
export function agentEnv(config: Config, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const secret = new Set(["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", config.tracker.tokenEnv]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !secret.has(k)) out[k] = v;
  }
  out.CONDUCTOR = "1";
  return out;
}

export interface HookResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

export async function runHook(name: string, script: string, cwd: string, timeoutMs: number, env: Record<string, string>): Promise<HookResult> {
  const proc = Bun.spawn(["bash", "-lc", script], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = (stdout + stderr).slice(-4000);
  const ok = !timedOut && code === 0;
  log(ok ? "info" : "warn", "hook_finished", { hook: name, cwd, code, timedOut, output: ok ? undefined : output });
  return { ok, code, output, timedOut };
}

export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: (stdout + stderr).trim() };
}

export interface PreparedWorkspace {
  path: string;
  created: boolean;
  branch: string;
  isGit: boolean;
}

export async function prepareWorkspace(config: Config, issue: Issue): Promise<PreparedWorkspace> {
  const path = workspacePath(config.workspace.root, issue.identifier);
  mkdirSync(config.workspace.root, { recursive: true });
  const created = !existsSync(path);
  if (created) mkdirSync(path, { recursive: true });
  const hookEnv = { ...(process.env as Record<string, string>), CONDUCTOR_ISSUE: issue.identifier, CONDUCTOR_ISSUE_NUMBER: String(issue.number) };

  if (created && config.hooks.afterCreate) {
    const r = await runHook("after_create", config.hooks.afterCreate, path, config.hooks.timeoutMs, hookEnv);
    if (!r.ok) {
      rmSync(path, { recursive: true, force: true });
      throw new Error(`after_create hook failed (code ${r.code}${r.timedOut ? ", timed out" : ""}): ${r.output.slice(-500)}`);
    }
  }

  mkdirSync(join(path, STATE_DIR), { recursive: true });
  const branch = branchName(config, issue);
  const isGit = (await git(path, ["rev-parse", "--is-inside-work-tree"])).code === 0;
  if (isGit) {
    // Keep conductor bookkeeping out of commits.
    const exclude = join(path, ".git", "info", "exclude");
    if (existsSync(join(path, ".git")) && !(existsSync(exclude) && readFileSync(exclude, "utf8").includes(STATE_DIR))) {
      mkdirSync(join(path, ".git", "info"), { recursive: true });
      appendFileSync(exclude, `\n${STATE_DIR}/\n`);
    }
    const current = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
    if (current !== branch) {
      const exists = (await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      const r = await git(path, exists ? ["checkout", branch] : ["checkout", "-b", branch]);
      if (r.code !== 0) throw new Error(`cannot check out ${branch}: ${r.out}`);
    }
    const basePath = join(path, STATE_DIR, "base");
    if (!existsSync(basePath)) {
      const base = (await git(path, ["merge-base", "HEAD", "origin/HEAD"])).out || (await git(path, ["rev-parse", "HEAD"])).out;
      writeFileSync(basePath, base.split("\n")[0] ?? "");
    }
  }

  if (config.hooks.beforeRun) {
    const r = await runHook("before_run", config.hooks.beforeRun, path, config.hooks.timeoutMs, hookEnv);
    if (!r.ok) throw new Error(`before_run hook failed (code ${r.code}): ${r.output.slice(-500)}`);
  }
  return { path, created, branch, isGit };
}

export async function afterRun(config: Config, path: string) {
  if (config.hooks.afterRun && existsSync(path)) {
    await runHook("after_run", config.hooks.afterRun, path, config.hooks.timeoutMs, process.env as Record<string, string>);
  }
}

export async function removeWorkspace(config: Config, identifier: string) {
  const path = workspacePath(config.workspace.root, identifier);
  if (!existsSync(path)) return;
  if (config.hooks.beforeRemove) {
    await runHook("before_remove", config.hooks.beforeRemove, path, config.hooks.timeoutMs, process.env as Record<string, string>);
  }
  rmSync(path, { recursive: true, force: true });
  log("info", "workspace_removed", { identifier, path });
}

// ---------- bookkeeping files inside the workspace ----------

export interface SessionRecord {
  agent: string;
  sessionId: string;
  updatedAt: string;
}

export function readSession(path: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(join(path, STATE_DIR, "session.json"), "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

export function writeSession(path: string, record: SessionRecord) {
  writeFileSync(join(path, STATE_DIR, "session.json"), JSON.stringify(record, null, 2));
}

export const REPORT_FILE = `${STATE_DIR}/result.json`;

export function readReport(path: string): AgentReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(path, REPORT_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.status !== "done" && r.status !== "blocked") return null;
  return {
    status: r.status,
    summary: typeof r.summary === "string" ? r.summary : "",
    prTitle: typeof r.pr_title === "string" ? r.pr_title : typeof r.prTitle === "string" ? r.prTitle : undefined,
  };
}

export function clearReport(path: string) {
  rmSync(join(path, REPORT_FILE), { force: true });
}

/** Commit leftovers, then report whether the branch has commits beyond its base. */
export async function finalizeCommits(path: string, issue: Issue): Promise<{ ahead: number }> {
  const status = await git(path, ["status", "--porcelain"]);
  if (status.out) {
    await git(path, ["add", "-A"]);
    await git(path, ["commit", "-m", `conductor: changes for #${issue.number}`, "--no-verify"]);
  }
  let base = "";
  try {
    base = readFileSync(join(path, STATE_DIR, "base"), "utf8").trim();
  } catch {}
  if (!base) return { ahead: 0 };
  const count = await git(path, ["rev-list", "--count", `${base}..HEAD`]);
  return { ahead: Number(count.out) || 0 };
}

export async function pushBranch(path: string, branch: string) {
  const r = await git(path, ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  if (r.code !== 0) throw new Error(`git push failed: ${r.out.slice(-500)}`);
}
