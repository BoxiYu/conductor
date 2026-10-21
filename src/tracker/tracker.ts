import type { Issue } from "../types.ts";

export interface PullRequestRef {
  number: number;
  url: string;
  headBranch: string;
}

/**
 * Tracker adapter. The orchestrator is the only caller: agents never get tracker credentials.
 * All state changes (labels, comments, PRs) are made host-side.
 */
export interface Tracker {
  fetchCandidates(): Promise<Issue[]>;
  fetchByIds(ids: string[]): Promise<Issue[]>;
  fetchTerminal(): Promise<Issue[]>;
  setState(issue: Issue, state: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  /** Review comments and reviews on the issue's PR plus issue comments, newest last. */
  fetchFeedback(issue: Issue, pr: PullRequestRef | null): Promise<string>;
  findPullRequest(issue: Issue, branch: string): Promise<PullRequestRef | null>;
  openPullRequest(input: {
    issue: Issue;
    branch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequestRef>;
}

export interface StateRules {
  statePrefix: string;
  defaultState: string;
  terminalStates: string[];
  /** Known states in precedence order, used when an issue carries several state labels. */
  precedence: string[];
}

export const norm = (s: string) => s.trim().toLowerCase();

/** Derive the workflow state of an issue from open/closed and `state:*` labels. */
export function deriveState(open: boolean, labels: string[], rules: StateRules): string {
  if (!open) return rules.terminalStates[0] ?? "Closed";
  const prefix = norm(rules.statePrefix);
  const found = labels
    .filter((l) => norm(l).startsWith(prefix))
    .map((l) => l.trim().slice(rules.statePrefix.trim().length).trim())
    .filter(Boolean);
  if (found.length === 0) return rules.defaultState;
  const rank = (s: string) => {
    const i = rules.precedence.findIndex((p) => norm(p) === norm(s));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  found.sort((a, b) => rank(a) - rank(b));
  const best = found[0]!;
  // Report the canonical casing when the state is known.
  return rules.precedence.find((p) => norm(p) === norm(best)) ?? best;
}

/** `priority:1` .. `priority:4` labels map to Symphony-style priorities (1 = most urgent). */
export function derivePriority(labels: string[]): number | null {
  for (const l of labels) {
    const m = /^(?:priority|p)[:\s-]*([1-4])$/i.exec(l.trim());
    if (m) return Number(m[1]);
  }
  return null;
}
