// In-memory tracker for tests and dry runs.

import type { Config, Issue } from "../types.ts";
import { norm, type PullRequestRef, type Tracker } from "./tracker.ts";

export class MemoryTracker implements Tracker {
  issues = new Map<string, Issue>();
  comments: { issueId: string; body: string }[] = [];
  prs = new Map<string, PullRequestRef>();
  feedback = new Map<string, string>();
  private nextPr = 1;

  constructor(private readonly config: Config) {}

  add(issue: Partial<Issue> & { number: number; title: string }): Issue {
    const full: Issue = {
      id: String(issue.number),
      identifier: `mem-${issue.number}`,
      description: null,
      state: this.config.tracker.defaultState,
      labels: [...this.config.tracker.requiredLabels],
      url: `memory://issues/${issue.number}`,
      priority: null,
      createdAt: new Date(Date.now() + issue.number).toISOString(),
      updatedAt: null,
      ...issue,
    };
    this.issues.set(full.id, full);
    return full;
  }

  private copy(i: Issue): Issue {
    return { ...i, labels: [...i.labels] };
  }

  async fetchCandidates() {
    const terminal = this.config.tracker.terminalStates.map(norm);
    return [...this.issues.values()].filter((i) => !terminal.includes(norm(i.state))).map((i) => this.copy(i));
  }

  async fetchByIds(ids: string[]) {
    return ids.flatMap((id) => {
      const i = this.issues.get(id);
      return i ? [this.copy(i)] : [];
    });
  }

  async fetchTerminal() {
    const terminal = this.config.tracker.terminalStates.map(norm);
    return [...this.issues.values()].filter((i) => terminal.includes(norm(i.state))).map((i) => this.copy(i));
  }

  async setState(issue: Issue, state: string) {
    issue.state = state;
    const stored = this.issues.get(issue.id);
    if (stored) stored.state = state;
  }

  async comment(issue: Issue, body: string) {
    this.comments.push({ issueId: issue.id, body });
  }

  async fetchFeedback(issue: Issue) {
    return this.feedback.get(issue.id) ?? "";
  }

  async findPullRequest(issue: Issue) {
    return this.prs.get(issue.id) ?? null;
  }

  async openPullRequest(input: { issue: Issue; branch: string }) {
    const pr = { number: this.nextPr++, url: `memory://pulls/${input.issue.id}`, headBranch: input.branch };
    this.prs.set(input.issue.id, pr);
    return pr;
  }
}
