// Status server, bound to 127.0.0.1 only.
//   GET  /                -> live dashboard
//   GET  /api/v1/state    -> JSON snapshot
//   GET  /api/v1/stream   -> Server-Sent Events: a snapshot whenever something changes
//   POST /api/v1/refresh  -> run a poll tick now

import type { Orchestrator } from "./orchestrator.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";
import { log } from "./log.ts";

/** Reject requests whose Host is not this loopback server (guards against DNS rebinding). */
export function hostAllowed(host: string | null, port: number): boolean {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

export function startServer(orch: Orchestrator, port: number) {
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // SSE connections stay open
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!hostAllowed(req.headers.get("host"), srv.port ?? port)) return new Response("forbidden", { status: 403 });

      if (url.pathname === "/api/v1/state" && req.method === "GET") return Response.json(orch.snapshot());

      if (url.pathname === "/api/v1/stream" && req.method === "GET") {
        let timer: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let lastVersion = -1;
            let lastSent = 0;
            const send = () => {
              const snap = orch.snapshot();
              // Push on change; otherwise a heartbeat every 15 s keeps proxies and the browser happy.
              if (snap.version === lastVersion && Date.now() - lastSent < 15_000) return;
              lastVersion = snap.version;
              lastSent = Date.now();
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(snap)}\n\n`));
              } catch {
                if (timer) clearInterval(timer);
              }
            };
            send();
            timer = setInterval(send, 1000);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        });
        req.signal.addEventListener("abort", () => timer && clearInterval(timer));
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      if (url.pathname === "/api/v1/refresh" && req.method === "POST") {
        void orch.tick();
        return Response.json({ ok: true }, { status: 202 });
      }

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(DASHBOARD_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // Everything is inline; nothing loads from elsewhere.
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log("info", "server_started", { url: `http://127.0.0.1:${server.port}/` });
  return server;
}
