#!/usr/bin/env bun
// conductor [WORKFLOW.md] [--once] [--port N] [--check]

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { Orchestrator } from "./orchestrator.ts";
import { GitHubTracker, resolveGitHubToken } from "./tracker/github.ts";
import { MemoryTracker } from "./tracker/memory.ts";
import type { Tracker } from "./tracker/tracker.ts";
import { loadWorkflow, validateForDispatch, WorkflowError } from "./workflow.ts";
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
    process.stdout.write(problems.length ? `\nproblems:\n- ${problems.join("\n- ")}\n` : "\nworkflow OK\n");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  let tracker: Tracker;
  if (config.tracker.kind === "github") {
    tracker = new GitHubTracker(config, await resolveGitHubToken(config.tracker.tokenEnv));
  } else {
    tracker = new MemoryTracker(config);
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

main().catch((err) => {
  log("error", "fatal", { error: (err as Error).message });
  process.exit(1);
});
