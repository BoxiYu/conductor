// Structured JSON-lines logging to stderr. Never pass secrets in fields.

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.CONDUCTOR_LOG_LEVEL as Level) || "info";
let sink: (line: string) => void = (line) => process.stderr.write(line + "\n");

export function setLogLevel(level: Level) {
  minLevel = level;
}

export function setLogSink(fn: (line: string) => void) {
  sink = fn;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (order[level] < order[minLevel]) return;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean }));
}
