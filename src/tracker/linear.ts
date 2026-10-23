// Linear tracker (GraphQL API). Issues and workflow states live in Linear; branches and pull
// requests live on GitHub (GitHubForge). Branch names carry the Linear identifier (e.g.
// `conductor/py-14-...`) and PR bodies say `Fixes PY-14`, so Linear's GitHub integration links
// the PR and closes the issue on merge. Conductor also attaches the PR link to the issue itself.

import type { Config, Issue } from "../types.ts";
import { latest, type GitHubForge } from "./github.ts";
import { MARKER, norm, type PullRequestRef, type Tracker } from "./tracker.ts";
import { log } from "../log.ts";

const ISSUE_FIELDS = `
  id identifier number title description url priority createdAt updatedAt
  state { name type }
  labels { nodes { name } }
`;

interface LinearIssueNode {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: { name: string; type: string } | null;
  labels: { nodes: { name: string }[] } | null;
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface TeamInfo {
  id: string;
  key: string;
  states: Map<string, { id: string; name: string; type: string }>;
}

export class LinearError extends Error {}

export class LinearTracker implements Tracker {
  private readonly endpoint = "https://api.linear.app/graphql";
  private team: TeamInfo | null = null;

  constructor(
    private readonly config: Config,
    private readonly token: string,
    readonly forge: GitHubForge,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * How long to wait before re-checking a hand-off state. Linear's Git automation
     * ("PR opened → In Progress") can move the issue back about a second after Conductor
     * moves it to review, which would make Conductor pick the finished issue up again.
     */
    private readonly settleDelaysMs: number[] = [3000, 6000],
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // Personal API keys go in the header as-is; OAuth tokens need "Bearer".
    const auth = this.token.startsWith("lin_oauth") ? `Bearer ${this.token}` : this.token;
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", "User-Agent": "conductor" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new LinearError(`Linear HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.extensions?.code ? `${e.message} (${e.extensions.code})` : e.message).join("; ");
      throw new LinearError(`Linear ${res.status === 429 ? "rate limit: " : ""}${msg.slice(0, 500)}`);
    }
    if (!res.ok || !json.data) throw new LinearError(`Linear HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json.data;
  }

  private async ensureTeam(): Promise<TeamInfo> {
    if (this.team) return this.team;
    const key = this.config.tracker.team;
    const data = await this.gql<{ teams: { nodes: { id: string; key: string; states: { nodes: { id: string; name: string; type: string }[] } }[] } }>(
      `query Team($key: String!) {
        teams(filter: { key: { eqIgnoreCase: $key } }) {
          nodes { id key states(first: 100) { nodes { id name type } } }
        }
      }`,
      { key },
    );
    const t = data.teams.nodes[0];
    if (!t) throw new LinearError(`Linear team \`${key}\` not found (check tracker.team and the API key's workspace)`);
    this.team = { id: t.id, key: t.key, states: new Map(t.states.nodes.map((s) => [norm(s.name), s])) };
    return this.team;
  }

  /** Problems that would stop dispatch: missing team or workflow states. Used by --check and startup. */
  async validate(): Promise<string[]> {
    let team: TeamInfo;
    try {
      team = await this.ensureTeam();
    } catch (err) {
      return [(err as Error).message];
    }
    const t = this.config.tracker;
    const needed = new Set([t.inProgressState, t.reviewState, t.blockedState, ...t.activeStates]);
    const missing = [...needed].filter((s) => !team.states.has(norm(s)));
    const have = [...team.states.values()].map((s) => s.name).join(", ");
    return missing.length
      ? [`Linear team ${team.key} has no state(s) ${missing.map((m) => `"${m}"`).join(", ")}; it has: ${have}`]
      : [];
  }

  normalize(n: LinearIssueNode): Issue {
    return {
      id: n.id,
      identifier: n.identifier,
      number: n.number,
      branchKey: n.identifier.toLowerCase(),
      title: n.title,
      description: n.description,
      state: n.state?.name ?? "",
      labels: n.labels?.nodes.map((l) => l.name) ?? [],
      url: n.url,
      // Linear: 0 = none, 1 = urgent ... 4 = low (same scale as Symphony).
      priority: n.priority && n.priority >= 1 && n.priority <= 4 ? n.priority : null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    };
  }

  private baseFilter(): Record<string, unknown>[] {
    const t = this.config.tracker;
    const and: Record<string, unknown>[] = [{ team: { key: { eqIgnoreCase: t.team } } }];
    if (t.project.trim()) and.push({ project: { name: { eqIgnoreCase: t.project } } });
    for (const label of t.requiredLabels.filter((l) => l.trim())) {
      and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
    }
    return and;
  }

  private async issues(filter: Record<string, unknown>, maxPages = 10, orderBy?: "updatedAt"): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const data: { issues: Page<LinearIssueNode> } = await this.gql(
        `query Issues($filter: IssueFilter, $after: String${orderBy ? ", $orderBy: PaginationOrderBy" : ""}) {
          issues(first: 50, after: $after, filter: $filter${orderBy ? ", orderBy: $orderBy" : ""}) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after, ...(orderBy ? { orderBy } : {}) },
      );
      out.push(...data.issues.nodes.map((n) => this.normalize(n)));
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
    }
    return out;
  }

  async fetchCandidates(): Promise<Issue[]> {
    return this.issues({ and: [...this.baseFilter(), { state: { name: { in: this.config.tracker.activeStates } } }] });
  }

  async fetchByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    return this.issues({ id: { in: ids } }, Math.ceil(ids.length / 50) + 1);
  }

  async fetchTerminal(): Promise<Issue[]> {
    return this.issues(
      { and: [...this.baseFilter(), { state: { name: { in: this.config.tracker.terminalStates } } }] },
      2,
      "updatedAt",
    );
  }

  async setState(issue: Issue, state: string): Promise<void> {
    const team = await this.ensureTeam();
    const target = team.states.get(norm(state));
    if (!target) throw new LinearError(`Linear team ${team.key} has no state "${state}"`);
    const update = () =>
      this.gql(
        `mutation SetState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
        { id: issue.id, stateId: target.id },
      );
    await update();
    issue.state = target.name;

    const t = this.config.tracker;
    const isHandoff = [t.reviewState, t.blockedState].some((s) => norm(s) === norm(state));
    if (!isHandoff) return;
    for (const delay of this.settleDelaysMs) {
      await Bun.sleep(delay);
      const [now] = await this.fetchByIds([issue.id]);
      if (!now || norm(now.state) === norm(target.name)) continue;
      if (t.terminalStates.some((s) => norm(s) === norm(now.state))) return; // closed meanwhile: leave it
      log("warn", "linear_state_overridden", {
        issue: issue.identifier,
        expected: target.name,
        found: now.state,
        hint: "a Linear workflow automation (e.g. Git: 'PR opened') moved the issue; set it to 'No action' or to this state",
      });
      await update();
    }
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.gql(
      `mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
      { issueId: issue.id, body },
    );
  }

  async fetchFeedback(issue: Issue, pr: PullRequestRef | null): Promise<string> {
    const data = await this.gql<{
      issue: { comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] } } | null;
    }>(
      `query Feedback($id: String!) {
        issue(id: $id) { comments(first: 100) { nodes { body createdAt user { name } } } }
      }`,
      { id: issue.id },
    );
    const parts: string[] = [];
    const comments = [...(data.issue?.comments.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const c of comments) {
      if (isConductorComment(c.body)) continue;
      parts.push(`Linear comment by ${c.user?.name ?? "unknown"} (${c.createdAt}):\n${c.body}`);
    }
    if (pr) parts.push(...(await this.forge.pullRequestFeedback(pr)));
    return parts.join("\n\n---\n\n");
  }

  findPullRequest(_issue: Issue, branch: string) {
    return this.forge.findPullRequest(branch);
  }

  async openPullRequest(input: { issue: Issue; branch: string; title: string; body: string; draft: boolean }) {
    const pr = await this.forge.openPullRequest(input);
    // Show the PR on the Linear issue even without the GitHub integration installed.
    await this.gql(
      `mutation Link($issueId: String!, $url: String!, $title: String) {
        attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
      }`,
      { issueId: input.issue.id, url: pr.url, title: `PR #${pr.number}: ${input.title}` },
    ).catch(() => undefined);
    return pr;
  }

  closingReference(issue: Issue): string {
    return `Fixes ${issue.identifier}`;
  }

  async latestHumanActivity(issue: Issue, pr: PullRequestRef | null): Promise<string | null> {
    const data = await this.gql<{ issue: { comments: { nodes: { body: string; createdAt: string }[] } } | null }>(
      `query Activity($id: String!) { issue(id: $id) { comments(first: 100) { nodes { body createdAt } } } }`,
      { id: issue.id },
    );
    const times = (data.issue?.comments.nodes ?? []).filter((c) => !isConductorComment(c.body)).map((c) => c.createdAt);
    if (pr) times.push(...(await this.forge.pullRequestActivity(pr)));
    return latest(times);
  }
}

/** Linear may drop HTML comments from markdown, so also recognize our status lines by shape. */
export function isConductorComment(body: string): boolean {
  if (body.includes(MARKER)) return true;
  const first = body.trim().split("\n")[0] ?? "";
  return /^(🤖 Conductor picked this up|✅ \*\*.+\*\* finished|⛔ \*\*.+\*\* finished|⛔ Conductor gave up)/.test(first);
}
