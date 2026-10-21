import { describe, expect, test } from "bun:test";
import { parseWorkflow, renderPrompt, splitFrontMatter, validateForDispatch, WorkflowError } from "../src/workflow.ts";

describe("workflow", () => {
  test("splits front matter and body", () => {
    const { front, body } = splitFrontMatter("---\na: 1\n---\nhello");
    expect(front).toBe("a: 1");
    expect(body).toBe("hello");
    expect(splitFrontMatter("no front").body).toBe("no front");
  });

  test("applies defaults and defines all four agents", () => {
    const wf = parseWorkflow("---\ntracker:\n  repo: a/b\n---\nDo {{ issue.title }}", "/tmp/WORKFLOW.md");
    expect(wf.config.tracker.repo).toBe("a/b");
    expect(wf.config.tracker.requiredLabels).toEqual(["conductor"]);
    expect(Object.keys(wf.config.agents).sort()).toEqual(["agy", "claude", "codex", "grok"]);
    expect(wf.config.routing.default).toEqual(["codex", "claude", "agy", "grok"]);
    expect(validateForDispatch(wf.config)).toEqual([]);
  });

  test("resolves $VAR and relative workspace root", () => {
    const wf = parseWorkflow("---\ntracker:\n  repo: $REPO\nworkspace:\n  root: ws\n---\n", "/srv/x/WORKFLOW.md", { REPO: "o/r" });
    expect(wf.config.tracker.repo).toBe("o/r");
    expect(wf.config.workspace.root).toBe("/srv/x/ws");
  });

  test("disabled agents drop out of default routing", () => {
    const wf = parseWorkflow("---\ntracker: {repo: a/b}\nagents:\n  grok: {enabled: false}\n---\n", "/tmp/W.md");
    expect(wf.config.routing.default).toEqual(["codex", "claude", "agy"]);
  });

  test("rejects bad config", () => {
    expect(() => parseWorkflow("---\n- list\n---\n", "/tmp/W.md")).toThrow(WorkflowError);
    expect(() => parseWorkflow("---\nagent: {max_turns: 0}\n---\n", "/tmp/W.md")).toThrow(/max_turns/);
    expect(() => parseWorkflow("---\nrouting: {default: [nope]}\n---\n", "/tmp/W.md")).toThrow(/unknown agent/);
    expect(() => parseWorkflow("---\nagents:\n  x: {kind: gpt}\n---\n", "/tmp/W.md")).toThrow(/kind/);
    expect(validateForDispatch(parseWorkflow("", "/tmp/W.md").config)).toContain("tracker.repo must be set to owner/name");
  });

  test("verify commands are allowed for every agent on top of the git defaults", () => {
    const wf = parseWorkflow(
      "---\nverify: {commands: [bun test, ' ']}\nagents:\n  agy: {allowed_commands: [make]}\n---\n",
      "/tmp/W.md",
    );
    expect(wf.config.verify.commands).toEqual(["bun test"]);
    expect(wf.config.agents.claude!.allowedCommands).toContain("git commit");
    expect(wf.config.agents.claude!.allowedCommands).toContain("ls");
    expect(wf.config.agents.claude!.allowedCommands).not.toContain("git push");
    expect(wf.config.agents.claude!.allowedCommands.at(-1)).toBe("bun test");
    expect(wf.config.agents.agy!.allowedCommands).toEqual(["make", "bun test"]);
  });

  test("custom agent entries reuse an adapter kind", () => {
    const wf = parseWorkflow("---\nagents:\n  claude-fast: {kind: claude, args: [--model, haiku]}\n---\n", "/tmp/W.md");
    expect(wf.config.agents["claude-fast"]!.kind).toBe("claude");
    expect(wf.config.agents["claude-fast"]!.args).toEqual(["--model", "haiku"]);
  });

  test("strict template rendering", async () => {
    const issue = { identifier: "r-1", title: "Fix", description: null };
    const out = await renderPrompt("{{ issue.title }}{% if attempt %} again{% endif %}", { issue, attempt: null, agent: "codex", feedback: "" });
    expect(out).toBe("Fix");
    await expect(renderPrompt("{{ nope }}", { issue, attempt: null, agent: "codex", feedback: "" })).rejects.toThrow();
    await expect(renderPrompt("{{ issue.title | bogus }}", { issue, attempt: 1, agent: "codex", feedback: "" })).rejects.toThrow();
  });

  test("example workflow parses and renders", async () => {
    const text = await Bun.file(new URL("../WORKFLOW.example.md", import.meta.url)).text();
    const wf = parseWorkflow(text, "/tmp/WORKFLOW.md");
    const issue = { identifier: "r-1", title: "T", url: "u", state: "Todo", labels: ["conductor"], description: "d" };
    const out = await renderPrompt(wf.promptTemplate, { issue, attempt: 2, agent: "claude", feedback: "please rename" });
    expect(out).toContain("attempt #2");
    expect(out).toContain("please rename");
  });
});
