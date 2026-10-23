// LinearTracker against a scripted fake of the Linear GraphQL API.

import { describe, expect, test } from "bun:test";
import { LinearTracker, LinearError, isConductorComment } from "../src/tracker/linear.ts";
import type { GitHubForge } from "../src/tracker/github.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { MARKER } from "../src/tracker/tracker.ts";
import { branchName } from "../src/workspace.ts";

const config = parseWorkflow(
  `---
tracker:
  kind: linear
  team: PY
  repo: me/site
  required_labels: [conductor]
  review_state: 待我审
  blocked_state: 卡住
---
`,
  "/tmp/W.md",
).config;

const STATES = ["Backlog", "Todo", "In Progress", "待我审", "卡住", "Done", "Canceled", "Duplicate"].map((name, i) => ({
  id: `s${i}`,
  name,
  type: "started",
}));

const node = (over: Record<string, unknown> = {}) => ({
  id: "uuid-14",
  identifier: "PY-14",
  number: 14,
  title: "Add practice questions to ep 7",
  description: "do it",
  url: "https://linear.app/x/issue/PY-14",
  priority: 2,
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "conductor" }, { name: "agent:claude" }] },
  ...over,
});

type Call = { query: string; variables: Record<string, unknown> };

function fakeLinear(handler: (c: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call;
    calls.push(body);
    if (/teams\(/.test(body.query)) {
      return Response.json({ data: { teams: { nodes: [{ id: "team-1", key: "PY", states: { nodes: STATES } }] } } });
    }
    return new Response(JSON.stringify(handler(body)), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const forge = {
  repo: "me/site",
  findPullRequest: async () => null,
  openPullRequest: async (i: { branch: string }) => ({ number: 3, url: "https://github.com/me/site/pull/3", headBranch: i.branch }),
  pullRequestFeedback: async () => ["PR review (CHANGES_REQUESTED) by @boxi:\nplease rename"],
} as unknown as GitHubForge;

describe("linear tracker", () => {
  test("config defaults for kind: linear", () => {
    expect(config.tracker.tokenEnv).toBe("LINEAR_API_KEY");
    expect(config.tracker.terminalStates).toEqual(["Done", "Canceled", "Duplicate"]);
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
  });

  test("fetchCandidates filters by team, labels and active states, and normalizes", async () => {
    const { calls, fetchImpl } = fakeLinear(() => ({
      data: { issues: { nodes: [node()], pageInfo: { hasNextPage: false, endCursor: null } } },
    }));
    const t = new LinearTracker(config, "lin_api_x", forge, fetchImpl);
    const [issue] = await t.fetchCandidates();
    expect(issue).toMatchObject({
      id: "uuid-14",
      identifier: "PY-14",
      branchKey: "py-14",
      state: "Todo",
      labels: ["conductor", "agent:claude"],
      priority: 2,
    });
    const filter = JSON.stringify(calls[0]!.variables.filter);
    expect(filter).toContain('"team":{"key":{"eqIgnoreCase":"PY"}}');
    expect(filter).toContain('"labels":{"some":{"name":{"eqIgnoreCase":"conductor"}}}');
    expect(filter).toContain('"state":{"name":{"in":["Todo","In Progress"]}}');
    expect(branchName(config, issue!)).toBe("conductor/py-14-add-practice-questions-to-ep-7");
    expect(t.closingReference(issue!)).toBe("Fixes PY-14");
  });

  test("paginates", async () => {
    let page = 0;
    const { calls, fetchImpl } = fakeLinear(() => {
      page++;
      return {
        data: {
          issues: {
            nodes: [node({ id: `u${page}`, identifier: `PY-${page}` })],
            pageInfo: { hasNextPage: page < 2, endCursor: `c${page}` },
          },
        },
      };
    });
    const t = new LinearTracker(config, "lin_api_x", forge, fetchImpl);
    expect((await t.fetchCandidates()).map((i) => i.identifier)).toEqual(["PY-1", "PY-2"]);
    expect(calls[1]!.variables.after).toBe("c1");
  });

  test("setState resolves the state id by name; unknown states fail clearly", async () => {
    const { calls, fetchImpl } = fakeLinear(() => ({ data: { issueUpdate: { success: true } } }));
    const t = new LinearTracker(config, "lin_api_x", forge, fetchImpl, []);
    const issue = t.normalize(node());
    await t.setState(issue, "待我审");
    const mutation = calls.find((c) => c.query.includes("issueUpdate"))!;
    expect(mutation.variables).toEqual({ id: "uuid-14", stateId: "s3" });
    expect(issue.state).toBe("待我审");
    await expect(t.setState(issue, "Nope")).rejects.toThrow(LinearError);
  });

  test("re-applies the review state when a Linear automation moves it back", async () => {
    let state = "In Progress";
    const { calls, fetchImpl } = fakeLinear((c) => {
      if (c.query.includes("issueUpdate")) {
        // The first update is overridden right away, like Linear's "PR opened" automation.
        const n = calls.filter((x) => x.query.includes("issueUpdate")).length;
        state = n === 1 ? "In Progress" : "待我审";
        return { data: { issueUpdate: { success: true } } };
      }
      return { data: { issues: { nodes: [node({ state: { name: state, type: "started" } })], pageInfo: { hasNextPage: false, endCursor: null } } } };
    });
    const t = new LinearTracker(config, "k", forge, fetchImpl, [5, 5]);
    await t.setState(t.normalize(node()), "待我审");
    expect(calls.filter((c) => c.query.includes("issueUpdate"))).toHaveLength(2);
    expect(state).toBe("待我审");
    // Non-handoff states are not re-checked.
    const before = calls.length;
    await t.setState(t.normalize(node()), "In Progress");
    expect(calls.length - before).toBe(1);
  });

  test("validate reports missing states", async () => {
    const strict = parseWorkflow("---\ntracker: {kind: linear, team: PY, repo: me/site, blocked_state: Blocked}\n---\n", "/tmp/W.md").config;
    const { fetchImpl } = fakeLinear(() => ({}));
    const problems = await new LinearTracker(strict, "k", forge, fetchImpl).validate();
    expect(problems[0]).toContain('"In Review"');
    expect(problems[0]).toContain('"Blocked"');
    expect(await new LinearTracker(config, "k", forge, fetchImpl).validate()).toEqual([]);
  });

  test("feedback skips Conductor's own comments and appends PR reviews", async () => {
    const { fetchImpl } = fakeLinear(() => ({
      data: {
        issue: {
          comments: {
            nodes: [
              { body: "Please also add a hint.", createdAt: "2026-10-22T00:00:00Z", user: { name: "Boxi" } },
              { body: "🤖 Conductor picked this up with **claude**.", createdAt: "2026-10-21T00:00:00Z", user: { name: "Boxi" } },
            ],
          },
        },
      },
    }));
    const t = new LinearTracker(config, "k", forge, fetchImpl);
    const fb = await t.fetchFeedback(t.normalize(node()), { number: 3, url: "u", headBranch: "b" });
    expect(fb).toContain("Please also add a hint.");
    expect(fb).not.toContain("picked this up");
    expect(fb).toContain("please rename");
  });

  test("openPullRequest attaches the PR link to the Linear issue", async () => {
    const { calls, fetchImpl } = fakeLinear(() => ({ data: { attachmentLinkURL: { success: true } } }));
    const t = new LinearTracker(config, "k", forge, fetchImpl);
    const pr = await t.openPullRequest({ issue: t.normalize(node()), branch: "conductor/py-14-x", title: "T", body: "B", draft: false });
    expect(pr.number).toBe(3);
    const link = calls.find((c) => c.query.includes("attachmentLinkURL"))!;
    expect(link.variables).toMatchObject({ issueId: "uuid-14", url: "https://github.com/me/site/pull/3" });
  });

  test("GraphQL errors and rate limits surface as LinearError", async () => {
    const { fetchImpl } = fakeLinear(() => ({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }), 429);
    const t = new LinearTracker(config, "k", forge, fetchImpl);
    await expect(t.fetchCandidates()).rejects.toThrow(/rate limit/i);
  });

  test("recognizes Conductor comments with or without the HTML marker", () => {
    expect(isConductorComment(`${MARKER}\nanything`)).toBe(true);
    expect(isConductorComment("✅ **agy** finished with status `done`.")).toBe(true);
    expect(isConductorComment("⛔ Conductor gave up after 3 attempts.")).toBe(true);
    expect(isConductorComment("The ✅ button is broken")).toBe(false);
  });
});
