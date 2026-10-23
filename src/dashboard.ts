// The live dashboard served at "/". One self-contained page: no external scripts, fonts or
// images. Data arrives over /api/v1/stream (SSE) with a polling fallback. All text from issues
// and agents is inserted with textContent, and only http(s) links are rendered.
//
// Note: this is a template literal, so the page must not contain backticks or "${", and every
// backslash in it must be doubled. (String.raw would keep the \uXXXX escapes Bun emits for
// non-ASCII text, so the Chinese labels would show up as escape codes.)

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conductor 运行面板</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #e3e6eb; --text: #1d2330; --muted: #667085;
  --accent: #4f46e5; --ok: #15803d; --ok-bg: #e7f6ec; --warn: #b45309; --warn-bg: #fdf3e2;
  --bad: #b91c1c; --bad-bg: #fde8e8; --info: #1d4ed8; --info-bg: #e6eefd; --chip: #f0f2f5;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #2a2f3a; --text: #e6e8ee; --muted: #9aa3b2;
    --accent: #8b87ff; --ok: #4ade80; --ok-bg: #12301d; --warn: #fbbf24; --warn-bg: #33270f;
    --bad: #f87171; --bad-bg: #3a1616; --info: #93b4ff; --info-bg: #17223d; --chip: #222733;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
header h1 { font-size: 16px; margin: 0; }
header .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
header .right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
.live.on i { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.live.off i { background: var(--bad); }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
main { max-width: 1280px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
section > h2 { font-size: 13px; text-transform: none; color: var(--muted); font-weight: 600; margin: 0 0 8px; display: flex; gap: 8px; align-items: baseline; }
section > h2 .n { color: var(--text); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.tile .k { color: var(--muted); font-size: 12px; }
.tile .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tile .s { color: var(--muted); font-size: 12px; }
.agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-width: 0; }
.agent .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.agent .name { font-weight: 650; }
.agent .kind { color: var(--muted); font-size: 12px; }
.agent .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; font-size: 12px; color: var(--muted); }
.agent .grid b { display: block; color: var(--text); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); white-space: nowrap; }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.bad { background: var(--bad-bg); color: var(--bad); }
.badge.info { background: var(--info-bg); color: var(--info); }
.runs { display: grid; gap: 10px; }
.run .head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.run .id { font-weight: 650; font-family: var(--mono); }
.run .title { font-weight: 550; overflow-wrap: anywhere; }
.run .facts { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.run .facts b { color: var(--text); font-weight: 600; }
.bar { height: 4px; background: var(--chip); border-radius: 4px; margin-top: 8px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
.tool { margin-top: 8px; font-family: var(--mono); font-size: 12px; background: var(--chip); border-radius: 8px; padding: 6px 8px; overflow-wrap: anywhere; }
.msg { margin-top: 6px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.links { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
.links .branch { font-family: var(--mono); color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); background: var(--panel); border: 1px dashed var(--line); border-radius: 12px; padding: 14px; text-align: center; }
.two { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .two { grid-template-columns: minmax(0, 1fr); } }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; white-space: nowrap; }
td.nowrap { white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td .sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.tablewrap { overflow-x: auto; border-radius: 12px; }
.feed { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-height: 560px; overflow-y: auto; }
.feed .row { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
.feed .row:last-child { border-bottom: 0; }
.feed .t { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.feed .line { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.feed .text { color: var(--muted); overflow-wrap: anywhere; width: 100%; }
.mono { font-family: var(--mono); }
.hidden { display: none !important; }
footer { color: var(--muted); font-size: 12px; text-align: center; padding: 8px 16px 24px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<header>
  <h1>Conductor</h1>
  <div class="meta" id="meta"></div>
  <div class="right">
    <span class="live" id="live"><i></i><span>连接中</span></span>
    <button id="poll" type="button" title="立即从看板拉一次单子">立即轮询</button>
  </div>
</header>
<main>
  <section><div class="tiles" id="tiles"></div></section>
  <section><h2>Agent</h2><div class="agents" id="agents"></div></section>
  <section><h2>正在运行 <span class="n" id="runningCount"></span></h2><div class="runs" id="running"></div></section>
  <section id="retrySection"><h2>重试队列 <span class="n" id="retryCount"></span></h2><div class="tablewrap" id="retrying"></div></section>
  <div class="two">
    <section><h2>最近结束 <span class="n" id="finishedCount"></span></h2><div class="tablewrap" id="finished"></div></section>
    <section><h2>动态</h2><div class="feed" id="activity"></div></section>
  </div>
</main>
<footer id="footer"></footer>
<script>
(function () {
  "use strict";
  var snap = null;
  var receivedAt = 0;
  var serverOffset = 0;

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = String(attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function safeUrl(u) { return typeof u === "string" && /^https?:\\/\\//i.test(u) ? u : null; }
  function link(u, text, cls) {
    var s = safeUrl(u);
    return s ? h("a", { href: s, target: "_blank", rel: "noopener noreferrer", class: cls || null, text: text }) : h("span", { class: cls || null, text: text });
  }
  function now() { return Date.now() + serverOffset; }
  function ms(iso) { return Date.parse(iso); }
  function dur(msv) {
    if (!(msv >= 0)) return "-";
    var s = Math.floor(msv / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + " 分 " + (s < 10 ? "0" : "") + s + " 秒";
    var hh = Math.floor(m / 60); m = m % 60;
    return hh + " 小时 " + m + " 分";
  }
  function ago(iso) { return iso ? dur(now() - ms(iso)) + "前" : "-"; }
  function clock(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function num(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var KIND = {
    dispatched: ["派单", "info"], turn: ["一轮完成", ""], turn_failed: ["本轮失败", "bad"], denied: ["权限被拒", "warn"],
    rate_limit: ["限流", "warn"], cooldown: ["冷却", "warn"], handoff: ["交付", "ok"], retry: ["重试", "warn"],
    gave_up: ["放弃", "bad"], stopped: ["已停止", ""], restored: ["状态复原", "warn"]
  };
  var OUTCOME = {
    handoff: ["交付", "ok"], inactive: ["已移出", ""], exhausted: ["轮次用尽", "warn"], failed: ["失败", "bad"], stopped: ["已停止", ""]
  };
  var PHASE = { preparing: "准备工作区", running: "运行中", "handing off": "交付中" };

  function renderMeta() {
    var t = snap.tracker || {};
    var board = t.kind === "linear" ? "Linear · " + (t.team || "") + (t.project ? " / " + t.project : "") : t.kind === "github" ? "GitHub Issues" : t.kind;
    var meta = $("meta"); clear(meta);
    meta.appendChild(h("span", { text: board }));
    meta.appendChild(h("span", { class: "mono", text: snap.repo || "" }));
    meta.appendChild(h("span", { text: "已运行 " + dur(now() - ms(snap.bootedAt)) }));
    meta.appendChild(h("span", { text: "每 " + Math.round(snap.limits.pollIntervalMs / 1000) + " 秒轮询" }));
  }

  function tile(k, v, s) { return h("div", { class: "tile" }, [h("div", { class: "k", text: k }), h("div", { class: "v", text: v }), s ? h("div", { class: "s", text: s }) : null]); }
  function renderTiles() {
    var el = $("tiles"); clear(el);
    var t = snap.totals;
    var cooling = Object.keys(snap.cooldowns || {});
    el.appendChild(tile("正在运行", snap.counts.running + " / " + snap.limits.maxConcurrentAgents, "并发上限"));
    el.appendChild(tile("重试排队", String(snap.counts.retrying), cooling.length ? "冷却中：" + cooling.join("、") : "没有 agent 在冷却"));
    el.appendChild(tile("已交付", String(t.handoffs), "共派单 " + t.runs + " 次"));
    el.appendChild(tile("失败", String(t.failures), "不含限流换人"));
    el.appendChild(tile("Token", num(t.inputTokens) + " / " + num(t.outputTokens), "输入 / 输出"));
  }

  function renderAgents() {
    var el = $("agents"); clear(el);
    snap.agents.forEach(function (a) {
      var status;
      if (!a.enabled) status = h("span", { class: "badge", text: "已停用" });
      else if (a.cooldownUntil && ms(a.cooldownUntil) > now()) status = h("span", { class: "badge warn", text: "冷却 " + dur(ms(a.cooldownUntil) - now()) });
      else if (a.running > 0) status = h("span", { class: "badge info", text: "忙 " + a.running + " / " + a.maxConcurrent });
      else status = h("span", { class: "badge ok", text: "空闲 0 / " + a.maxConcurrent });
      var s = a.stats;
      function stat(label, v) { return h("div", null, [h("b", { text: v }), label]); }
      el.appendChild(h("div", { class: "card agent" }, [
        h("div", { class: "top" }, [h("span", { class: "name", text: a.name }), a.kind !== a.name ? h("span", { class: "kind", text: a.kind }) : null, h("span", { style: "margin-left:auto" }, [status])]),
        !a.inRotation && a.enabled ? h("div", { class: "kind", style: "margin:-2px 0 6px", text: "不在默认轮转，只接打了 agent 标签的单" }) : null,
        h("div", { class: "grid" }, [
          stat("派单", String(s.runs)), stat("交付", String(s.handoffs)), stat("失败", String(s.failures)),
          stat("限流", String(s.rateLimits)), stat("工具调用", num(s.toolCalls)), stat("Token", num(s.inputTokens + s.outputTokens))
        ])
      ]));
    });
  }

  function renderRunning() {
    var el = $("running"); clear(el);
    $("runningCount").textContent = String(snap.running.length);
    if (!snap.running.length) { el.appendChild(h("div", { class: "empty", text: "没有在跑的单子。" })); return; }
    snap.running.forEach(function (r) {
      var quiet = now() - ms(r.lastEventAt);
      var stall = snap.limits.stallTimeoutMs;
      var quietBadge = stall > 0 && quiet > stall / 2 ? h("span", { class: "badge warn", text: "已 " + dur(quiet) + " 没有输出" }) : null;
      var pct = Math.min(100, Math.round((r.turn / Math.max(1, r.maxTurns)) * 100));
      el.appendChild(h("div", { class: "card run" }, [
        h("div", { class: "head" }, [
          link(r.url, r.issue, "id"),
          h("span", { class: "badge info", text: r.agent }),
          h("span", { class: "badge", text: PHASE[r.phase] || r.phase }),
          r.attempt ? h("span", { class: "badge warn", text: "第 " + (r.attempt + 1) + " 次尝试" }) : null,
          quietBadge
        ]),
        h("div", { class: "title", text: r.title }),
        h("div", { class: "facts" }, [
          h("span", null, ["轮次 ", h("b", { text: r.turn + " / " + r.maxTurns })]),
          h("span", null, ["已用时 ", h("b", { text: dur(now() - ms(r.startedAt)) })]),
          h("span", null, ["最近输出 ", h("b", { text: ago(r.lastEventAt) })]),
          h("span", null, ["工具调用 ", h("b", { text: String(r.toolCalls) })]),
          h("span", null, ["Token ", h("b", { text: num(r.usage.inputTokens) + " / " + num(r.usage.outputTokens) })]),
          h("span", null, ["看板状态 ", h("b", { text: r.state })])
        ]),
        h("div", { class: "bar" }, [h("i", { style: "width:" + pct + "%" })]),
        r.lastTool ? h("div", { class: "tool" }, [h("span", { text: r.lastTool.name }), r.lastTool.detail ? h("span", { text: "  " + r.lastTool.detail }) : null, h("span", { style: "color:var(--muted)", text: "  · " + ago(r.lastTool.at) })]) : null,
        r.lastText ? h("div", { class: "msg", text: r.lastText }) : null,
        h("div", { class: "links" }, [
          link(r.url, "看板单子 ↗"),
          r.prUrl ? link(r.prUrl, "PR ↗") : null,
          r.branch ? h("span", { class: "branch", text: r.branch }) : null
        ])
      ]));
    });
  }

  function table(headers, rows) {
    return h("table", null, [h("thead", null, [h("tr", null, headers.map(function (x) { return h("th", { text: x }); }))]), h("tbody", null, rows)]);
  }

  function renderRetrying() {
    var el = $("retrying"); clear(el);
    $("retryCount").textContent = String(snap.retrying.length);
    $("retrySection").classList.toggle("hidden", !snap.retrying.length);
    if (!snap.retrying.length) return;
    el.appendChild(table(["单子", "第几次", "多久后", "跳过的 agent", "原因"], snap.retrying.map(function (r) {
      var left = ms(r.dueAt) - now();
      return h("tr", null, [
        h("td", { class: "mono", text: r.issue }), h("td", { class: "num", text: String(r.attempt + 1) }),
        h("td", { class: "num", text: left > 0 ? dur(left) : "马上" }),
        h("td", { text: r.exclude && r.exclude.length ? r.exclude.join("、") : "-" }),
        h("td", null, [h("div", { class: "sub", text: r.error })])
      ]);
    })));
  }

  function renderFinished() {
    var el = $("finished"); clear(el);
    $("finishedCount").textContent = String(snap.finished.length);
    if (!snap.finished.length) { el.appendChild(h("div", { class: "empty", text: "还没有结束的任务。" })); return; }
    el.appendChild(table(["单子", "结果", "轮次", "用时", "Token", "PR"], snap.finished.slice(0, 30).map(function (f) {
      var o = OUTCOME[f.outcome] || [f.outcome, ""];
      var label = f.outcome === "handoff" && f.status === "blocked" ? "交付（卡住）" : o[0];
      var cls = f.outcome === "handoff" && f.status === "blocked" ? "warn" : o[1];
      return h("tr", null, [
        h("td", null, [link(f.issueUrl, f.issue, "mono"), h("div", { class: "sub", text: f.title }), h("div", { class: "sub", text: f.agent + " · " + ago(f.endedAt) })]),
        h("td", null, [h("span", { class: "badge " + cls, text: label }), f.error ? h("div", { class: "sub", text: f.error }) : null]),
        h("td", { class: "num", text: String(f.turns) }),
        h("td", { class: "num", text: dur(ms(f.endedAt) - ms(f.startedAt)) }),
        h("td", { class: "num", text: num(f.usage.inputTokens) + " / " + num(f.usage.outputTokens) }),
        h("td", { class: "nowrap" }, [f.prUrl ? link(f.prUrl, "PR ↗") : h("span", { class: "sub", text: "-" })])
      ]);
    })));
  }

  function renderActivity() {
    var el = $("activity"); clear(el);
    if (!snap.activity.length) { el.appendChild(h("div", { class: "empty", style: "border:0", text: "暂无动态。" })); return; }
    snap.activity.forEach(function (a) {
      var k = KIND[a.kind] || [a.kind, ""];
      el.appendChild(h("div", { class: "row" }, [
        h("div", { class: "t", text: clock(a.at), title: a.at }),
        h("div", { class: "line" }, [
          h("span", { class: "badge " + k[1], text: k[0] }),
          link(a.issueUrl, a.issue, "mono"),
          a.agent ? h("span", { class: "badge", text: a.agent }) : null,
          a.prUrl ? link(a.prUrl, "PR ↗") : null,
          h("div", { class: "text", text: a.text })
        ])
      ]));
    });
  }

  function render() {
    if (!snap) return;
    renderMeta(); renderTiles(); renderAgents(); renderRunning(); renderRetrying(); renderFinished(); renderActivity();
    $("footer").textContent = "数据更新于 " + ago(snap.generatedAt) + " · " + (snap.workflow || "");
  }

  function accept(data) {
    snap = data;
    receivedAt = Date.now();
    serverOffset = Date.parse(data.generatedAt) - receivedAt;
    render();
  }

  function setLive(state, text) {
    var el = $("live");
    el.className = "live " + state;
    el.lastChild.textContent = text;
  }

  var pollTimer = null;
  function poll() {
    fetch("/api/v1/state").then(function (r) { return r.json(); }).then(function (d) { accept(d); setLive("off", "轮询模式"); })
      .catch(function () { setLive("off", "连不上服务"); });
  }
  function connect() {
    if (!window.EventSource) { pollTimer = setInterval(poll, 3000); poll(); return; }
    var es = new EventSource("/api/v1/stream");
    es.onopen = function () { setLive("on", "实时"); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    es.onmessage = function (e) { try { accept(JSON.parse(e.data)); setLive("on", "实时"); } catch (err) {} };
    es.onerror = function () {
      setLive("off", "重连中");
      if (!pollTimer) { pollTimer = setInterval(poll, 3000); poll(); }
    };
  }

  $("poll").addEventListener("click", function () {
    var b = $("poll"); b.disabled = true; b.textContent = "轮询中…";
    fetch("/api/v1/refresh", { method: "POST" }).finally(function () { setTimeout(function () { b.disabled = false; b.textContent = "立即轮询"; }, 1200); });
  });

  // Relative times and countdowns move every second even when nothing new arrives.
  setInterval(render, 1000);
  connect();
})();
</script>
</body>
</html>`;
