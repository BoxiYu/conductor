// In-memory run history for the status dashboard: a short activity feed, recently finished runs
// and per-agent counters. Nothing here is persisted; a restart starts from zero.

import type { Usage } from "./types.ts";

export type ActivityKind =
  | "dispatched"
  | "turn"
  | "turn_failed"
  | "denied"
  | "rate_limit"
  | "cooldown"
  | "handoff"
  | "retry"
  | "gave_up"
  | "stopped"
  | "restored";

export interface Activity {
  at: number;
  kind: ActivityKind;
  issue: string;
  issueUrl: string | null;
  agent: string | null;
  text: string;
  /** Pull request link, for hand-offs. */
  prUrl: string | null;
}

export interface FinishedRun {
  issue: string;
  title: string;
  issueUrl: string;
  agent: string;
  /** handoff | inactive | exhausted | failed | stopped */
  outcome: string;
  /** done / blocked for hand-offs */
  status: string | null;
  error: string | null;
  prUrl: string | null;
  attempt: number;
  turns: number;
  usage: Usage;
  startedAt: number;
  endedAt: number;
}

export interface AgentStats {
  runs: number;
  handoffs: number;
  failures: number;
  rateLimits: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

const emptyStats = (): AgentStats => ({
  runs: 0,
  handoffs: 0,
  failures: 0,
  rateLimits: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export class Telemetry {
  readonly activity: Activity[] = [];
  readonly finished: FinishedRun[] = [];
  private readonly stats = new Map<string, AgentStats>();
  /** Bumped on every change so the dashboard stream can skip identical snapshots cheaply. */
  version = 0;

  constructor(
    private readonly now: () => number,
    private readonly maxActivity = 200,
    private readonly maxFinished = 50,
  ) {}

  event(kind: ActivityKind, issue: { identifier: string; url: string }, agent: string | null, text: string, prUrl: string | null = null) {
    this.activity.unshift({
      at: this.now(),
      kind,
      issue: issue.identifier,
      issueUrl: issue.url || null,
      agent,
      text: text.slice(0, 400),
      prUrl,
    });
    if (this.activity.length > this.maxActivity) this.activity.length = this.maxActivity;
    this.version++;
  }

  finish(run: FinishedRun) {
    this.finished.unshift(run);
    if (this.finished.length > this.maxFinished) this.finished.length = this.maxFinished;
    this.version++;
  }

  agent(name: string): AgentStats {
    let s = this.stats.get(name);
    if (!s) {
      s = emptyStats();
      this.stats.set(name, s);
    }
    this.version++;
    return s;
  }

  statsFor(name: string): AgentStats {
    return { ...(this.stats.get(name) ?? emptyStats()) };
  }
}
