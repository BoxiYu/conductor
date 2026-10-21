// GitHub Issues adapter (REST v3). Workflow state lives in `state:<name>` labels.

import type { Config, Issue } from "../types.ts";
import { deriveState, derivePriority, norm, type PullRequestRef, type StateRules, type Tracker } from "./tracker.ts";

interface GhLabel {
  name: string;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: (GhLabel | string)[];
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

export async function resolveGitHubToken(envName: string, env = process.env): Promise<string> {
  const fromEnv = env[envName] || env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    throw new Error(`no GitHub token: set $${envName} or run \`gh auth login\``);
  }
  return out;
}

export class GitHubTracker implements Tracker {
  private readonly api = "https://api.github.com";
  private readonly rules: StateRules;
  private defaultBranch: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const t = config.tracker;
    this.rules = {
      statePrefix: t.statePrefix,
      defaultState: t.defaultState,
      terminalStates: t.terminalStates,
      precedence: [t.reviewState, t.blockedState, "Rework", t.inProgressState, ...t.activeStates, t.defaultState],
    };
  }

  private get repo() {
    return this.config.tracker.repo;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "conductor",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  normalize(gh: GhIssue): Issue {
    const labels = gh.labels.map((l) => (typeof l === "string" ? l : l.name));
    const repoName = this.repo.split("/")[1] ?? "issue";
    return {
      id: String(gh.number),
      identifier: `${repoName}-${gh.number}`,
      number: gh.number,
      title: gh.title,
      description: gh.body,
      state: deriveState(gh.state === "open", labels, this.rules),
      labels,
      url: gh.html_url,
      priority: derivePriority(labels),
      createdAt: gh.created_at,
      updatedAt: gh.updated_at,
    };
  }

  private labelQuery(): string {
    const labels = this.config.tracker.requiredLabels.filter((l) => l.trim());
    return labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
  }

  async fetchCandidates(): Promise<Issue[]> {
    const raw = await this.paginate<GhIssue>(`/repos/${this.repo}/issues?state=open${this.labelQuery()}`);
    return raw.filter((i) => !i.pull_request).map((i) => this.normalize(i));
  }

  async fetchByIds(ids: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const id of ids) {
      try {
        out.push(this.normalize(await this.request<GhIssue>("GET", `/repos/${this.repo}/issues/${id}`)));
      } catch (err) {
        if (!String(err).includes("-> 404")) throw err;
      }
    }
    return out;
  }

  async fetchTerminal(): Promise<Issue[]> {
    const raw = await this.paginate<GhIssue>(
      `/repos/${this.repo}/issues?state=closed&sort=updated&direction=desc${this.labelQuery()}`,
      2,
    );
    return raw.filter((i) => !i.pull_request).map((i) => this.normalize(i));
  }

  async setState(issue: Issue, state: string): Promise<void> {
    const prefix = this.config.tracker.statePrefix;
    const target = `${prefix}${state}`;
    for (const l of issue.labels) {
      if (norm(l).startsWith(norm(prefix)) && norm(l) !== norm(target)) {
        await this.request("DELETE", `/repos/${this.repo}/issues/${issue.number}/labels/${encodeURIComponent(l)}`).catch(
          () => undefined,
        );
      }
    }
    if (norm(state) !== norm(this.config.tracker.defaultState)) {
      await this.request("POST", `/repos/${this.repo}/issues/${issue.number}/labels`, { labels: [target] });
    }
    issue.labels = [...issue.labels.filter((l) => !norm(l).startsWith(norm(prefix))), target];
    issue.state = state;
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.repo}/issues/${issue.number}/comments`, { body });
  }

  async fetchFeedback(issue: Issue, pr: PullRequestRef | null): Promise<string> {
    const parts: string[] = [];
    const comments = await this.paginate<{ user: { login: string } | null; body: string; created_at: string }>(
      `/repos/${this.repo}/issues/${issue.number}/comments`,
      3,
    );
    for (const c of comments) {
      if (c.body.includes("<!-- conductor -->")) continue; // our own status comments
      parts.push(`Issue comment by @${c.user?.login ?? "unknown"} (${c.created_at}):\n${c.body}`);
    }
    if (pr) {
      const reviews = await this.paginate<{ user: { login: string } | null; body: string; state: string }>(
        `/repos/${this.repo}/pulls/${pr.number}/reviews`,
        3,
      );
      for (const r of reviews) {
        if (r.body?.trim()) parts.push(`PR review (${r.state}) by @${r.user?.login ?? "unknown"}:\n${r.body}`);
      }
      const inline = await this.paginate<{ user: { login: string } | null; body: string; path: string; line: number | null }>(
        `/repos/${this.repo}/pulls/${pr.number}/comments`,
        3,
      );
      for (const c of inline) {
        parts.push(`PR inline comment by @${c.user?.login ?? "unknown"} on ${c.path}:${c.line ?? "?"}:\n${c.body}`);
      }
    }
    return parts.join("\n\n---\n\n");
  }

  private async getDefaultBranch(): Promise<string> {
    if (!this.defaultBranch) {
      const r = await this.request<{ default_branch: string }>("GET", `/repos/${this.repo}`);
      this.defaultBranch = r.default_branch;
    }
    return this.defaultBranch;
  }

  async findPullRequest(_issue: Issue, branch: string): Promise<PullRequestRef | null> {
    const owner = this.repo.split("/")[0];
    const prs = await this.request<{ number: number; html_url: string; head: { ref: string } }[]>(
      "GET",
      `/repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    const pr = prs[0];
    return pr ? { number: pr.number, url: pr.html_url, headBranch: pr.head.ref } : null;
  }

  async openPullRequest(input: { issue: Issue; branch: string; title: string; body: string; draft: boolean }) {
    const pr = await this.request<{ number: number; html_url: string; head: { ref: string } }>(
      "POST",
      `/repos/${this.repo}/pulls`,
      { title: input.title, head: input.branch, base: await this.getDefaultBranch(), body: input.body, draft: input.draft },
    );
    return { number: pr.number, url: pr.html_url, headBranch: pr.head.ref };
  }
}
