#!/usr/bin/env bun
// conductor [WORKFLOW.md] [--once] [--port N] [--check]

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { Orchestrator } from "./orchestrator.ts";
import { GitHubForge, GitHubTracker, resolveGitHubToken } from "./tracker/github.ts";
import { MemoryTracker } from "./tracker/memory.ts";
import { LinearTracker } from "./tracker/linear.ts";
import type { Tracker } from "./tracker/tracker.ts";
import { loadWorkflow, validateForDispatch, WorkflowError } from "./workflow.ts";
import type { Config } from "./types.ts";
import { startServer } from "./server.ts";
import { log } from "./log.ts";

const HELP = `conductor - turn GitHub issues into autonomous coding-agent runs

Usage: conductor [WORKFLOW.md] [options]

Options:
  --once        Run a single poll tick, wait for its workers and retries, then exit
  --check       Validate WORKFLOW.md and agent binaries, then exit
  --port <n>    Serve the status page on 127.0.0.1:<n> (overrides server.port)
  -h, --help    Show this help
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      once: { type: "boolean" },
      check: { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const path = positionals[0] ?? "WORKFLOW.md";
  if (!existsSync(path)) throw new WorkflowError(`workflow file not found: ${path} (copy WORKFLOW.example.md to start)`);
  const workflow = loadWorkflow(path);
  const config = workflow.config;

  if (values.check) {
    const problems = validateForDispatch(config);
    for (const [name, a] of Object.entries(config.agents)) {
      if (!a.enabled) continue;
      const found = Bun.which(a.command);
      process.stdout.write(`${found ? "ok " : "MISSING"} agent ${name} (${a.kind}): ${found ?? a.command}\n`);
      if (!found && config.routing.default.includes(name)) problems.push(`agent ${name}: \`${a.command}\` not on PATH`);
    }
    if (config.tracker.kind === "linear" && problems.length === 0) {
      try {
        const t = await makeTracker(config);
        const linearProblems = t instanceof LinearTracker ? await t.validate() : [];
        problems.push(...linearProblems);
        if (!linearProblems.length) process.stdout.write(`ok  linear team ${config.tracker.team}: states found\n`);
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    process.stdout.write(problems.length ? `\nproblems:\n- ${problems.join("\n- ")}\n` : "\nworkflow OK\n");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const tracker = await makeTracker(config);
  if (tracker instanceof LinearTracker) {
    const problems = await tracker.validate();
    if (problems.length) throw new WorkflowError(problems.join("; "));
  }

  const orch = new Orchestrator(workflow, { tracker });
  const port = values.port !== undefined ? Number(values.port) : config.server.port;

  if (values.once) {
    await orch.tick();
    await orch.drain();
    process.stdout.write(JSON.stringify(orch.snapshot(), null, 2) + "\n");
    await orch.stop();
    return;
  }

  if (port !== null && Number.isFinite(port)) startServer(orch, port);
  log("info", "conductor_started", { workflow: workflow.path, repo: config.tracker.repo, agents: config.routing.default });
  await orch.start();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) process.exit(130);
    stopping = true;
    log("info", "shutting_down", { signal: sig });
    await orch.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function makeTracker(config: Config): Promise<Tracker> {
  const t = config.tracker;
  if (t.kind === "memory") return new MemoryTracker(config);
  if (t.kind === "linear") {
    const key = process.env[t.tokenEnv];
    if (!key) throw new WorkflowError(`no Linear API key: set $${t.tokenEnv}`);
    return new LinearTracker(config, key, new GitHubForge(t.repo, await resolveGitHubToken(t.githubTokenEnv)));
  }
  return new GitHubTracker(config, new GitHubForge(t.repo, await resolveGitHubToken(t.tokenEnv)));
}

main().catch((err) => {
  log("error", "fatal", { error: (err as Error).message });
  process.exit(1);
});
