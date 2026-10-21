// Optional status server (binds to 127.0.0.1 only).
//   GET  /                -> small HTML status page
//   GET  /api/v1/state    -> JSON snapshot
//   POST /api/v1/refresh  -> run a poll tick now

import type { Orchestrator } from "./orchestrator.ts";
import { log } from "./log.ts";

export function startServer(orch: Orchestrator, port: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/state" && req.method === "GET") return Response.json(orch.snapshot());
      if (url.pathname === "/api/v1/refresh" && req.method === "POST") {
        void orch.tick();
        return Response.json({ ok: true }, { status: 202 });
      }
      if (url.pathname === "/" && req.method === "GET") return new Response(page(orch), { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  log("info", "server_started", { url: `http://127.0.0.1:${server.port}/` });
  return server;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(orch: Orchestrator): string {
  const s = orch.snapshot();
  const rows = s.running
    .map(
      (r) =>
        `<tr><td><a href="${esc(r.url)}">${esc(r.issue)}</a><br><small>${esc(r.title)}</small></td><td>${esc(r.agent)}</td><td>${r.turn}</td><td>${r.attempt}</td><td>${esc(r.lastEventAt)}</td><td><small>${esc(r.lastText)}</small></td></tr>`,
    )
    .join("");
  const retries = s.retrying
    .map((r) => `<tr><td>${esc(r.issue)}</td><td>${r.attempt}</td><td>${esc(r.dueAt)}</td><td><small>${esc(r.error)}</small></td></tr>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Conductor</title>
<style>body{font:14px system-ui;margin:24px;color:#222;background:#fff}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}td,th{border-color:#333}a{color:#8ab4f8}}</style>
<h1>Conductor · ${esc(s.repo)}</h1>
<p>running ${s.counts.running} · retrying ${s.counts.retrying} · handoffs ${s.totals.handoffs} · tokens ${s.totals.inputTokens}/${s.totals.outputTokens}
${Object.keys(s.cooldowns).length ? `· cooling down: ${esc(Object.keys(s.cooldowns).join(", "))}` : ""}</p>
<h2>Running</h2><table><tr><th>Issue</th><th>Agent</th><th>Turn</th><th>Attempt</th><th>Last event</th><th>Last message</th></tr>${rows || "<tr><td colspan=6>idle</td></tr>"}</table>
<h2>Retry queue</h2><table><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr>${retries || "<tr><td colspan=4>empty</td></tr>"}</table>`;
}
