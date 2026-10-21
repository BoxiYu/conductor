// Picks which agent runs an issue.
//
// 1. An `agent:<name>` label pins the issue to that agent (it waits if the agent is busy or cooling down).
// 2. Otherwise prefer the agent that already has a session in the workspace (so it can resume).
// 3. Otherwise walk routing.default, rotating the start point so load spreads across agents.
// Agents that recently hit a rate limit are skipped until their cooldown ends.

import type { Config, Issue } from "./types.ts";
import { norm } from "./tracker/tracker.ts";

export interface RouterView {
  running: (agent: string) => number;
  now: () => number;
}

export class Router {
  private cooldownUntil = new Map<string, number>();
  private cursor = 0;

  constructor(private config: Config) {}

  updateConfig(config: Config) {
    this.config = config;
  }

  coolDown(agent: string, now: number) {
    this.cooldownUntil.set(agent, now + this.config.agent.rateLimitCooldownMs);
  }

  cooldowns(now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [a, until] of this.cooldownUntil) if (until > now) out[a] = until;
    return out;
  }

  pinned(issue: Issue): string | null {
    const prefix = norm(this.config.routing.labelPrefix);
    for (const l of issue.labels) {
      if (norm(l).startsWith(prefix)) {
        const name = l.trim().slice(this.config.routing.labelPrefix.trim().length).trim();
        const match = Object.keys(this.config.agents).find((a) => norm(a) === norm(name));
        if (match) return match;
      }
    }
    return null;
  }

  available(agent: string, view: RouterView): boolean {
    const cfg = this.config.agents[agent];
    if (!cfg?.enabled) return false;
    if ((this.cooldownUntil.get(agent) ?? 0) > view.now()) return false;
    return view.running(agent) < cfg.maxConcurrent;
  }

  /**
   * @param previous agent that has a resumable session in the workspace
   * @param exclude agents that already failed this attempt chain (e.g. rate-limited just now)
   */
  pick(issue: Issue, view: RouterView, previous: string | null = null, exclude: string[] = []): string | null {
    const pinned = this.pinned(issue);
    if (pinned) return this.available(pinned, view) ? pinned : null;
    if (previous && !exclude.includes(previous) && this.config.routing.default.includes(previous) && this.available(previous, view)) {
      return previous;
    }
    const order = this.config.routing.default;
    for (let i = 0; i < order.length; i++) {
      const name = order[(this.cursor + i) % order.length]!;
      if (exclude.includes(name)) continue;
      if (this.available(name, view)) {
        this.cursor = (this.cursor + i + 1) % order.length;
        return name;
      }
    }
    return null;
  }
}
