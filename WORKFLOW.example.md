---
# Copy to WORKFLOW.md (ideally inside the target repo) and adjust.
tracker:
  kind: github
  repo: OWNER/NAME                 # issues of this repo are the work queue
  required_labels: [conductor]     # only issues with every label here are picked up
  state_label_prefix: "state:"     # state lives in labels like `state:rework`
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Closed]        # closed issue = done; its workspace is removed

polling:
  interval_ms: 30000

workspace:
  root: ~/conductor-workspaces
  branch_prefix: conductor/

hooks:
  # Runs once when a workspace is created. The orchestrator then creates the issue branch.
  after_create: |
    git clone --depth 50 https://github.com/OWNER/NAME.git .
  # before_run: |
  #   bun install --frozen-lockfile
  timeout_ms: 300000

agent:
  max_concurrent_agents: 4
  max_turns: 10
  max_attempts: 5
  stall_timeout_ms: 600000
  rate_limit_cooldown_ms: 900000

routing:
  default: [codex, claude, agy, grok]   # rotated; rate-limited agents are skipped for a while
  label_prefix: "agent:"                # label `agent:claude` pins an issue to claude

verify:
  # Commands the agent should run to check its work. They are listed in the prompt and
  # auto-allowed for claude (other CLIs follow their own sandbox settings).
  commands: ["bun test"]

handoff:
  open_pull_request: true
  draft: false

server:
  port: 4141

agents:
  codex:
    max_concurrent: 2
    # args: ["--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"',
    #        "-c", "sandbox_workspace_write.network_access=true", "-m", "gpt-5.5"]
  claude:
    max_concurrent: 2
    # Commands claude may run without approval (prefix match). verify.commands are added on top.
    # allowed_commands: ["git status", "git diff", "git log", "git add", "git commit"]
    # args: ["--permission-mode", "acceptEdits", "--model", "opus"]
  agy:
    max_concurrent: 1
    # Headless agy refuses every shell command by default (tests included). This auto-approves
    # everything: only use it when Conductor runs in a container / VM / dedicated user.
    # With --sandbox kept, agy runs tests but cannot `git commit`; Conductor commits for it.
    # args: ["--sandbox", "--dangerously-skip-permissions"]
  grok:
    max_concurrent: 1
    # Headless grok refuses even file writes under acceptEdits. --yolo auto-approves everything:
    # only use it when Conductor runs in a container / VM / dedicated user.
    # args: ["--yolo"]
    # enabled: false
---

You are working on GitHub issue {{ issue.identifier }} in this repository.

Title: {{ issue.title }}
URL: {{ issue.url }}
State: {{ issue.state }}
Labels: {{ issue.labels | join: ", " }}

{% if attempt %}
This is attempt #{{ attempt }}. The workspace keeps your earlier work: inspect `git log` and `git status`
and continue from there instead of starting over.
{% endif %}

Description:
{% if issue.description %}{{ issue.description }}{% else %}(no description){% endif %}

{% if feedback != "" %}
Reviewer feedback to address (from the issue and its pull request):

{{ feedback }}
{% endif %}

How to work:
1. Read the relevant code first and reproduce the problem or confirm the current behavior.
2. Make the smallest change that solves the issue. Follow the repository's AGENTS.md / CLAUDE.md if present.
3. Run the project's tests, linters and type checks that cover your change. Fix what you broke.
4. Commit with clear messages. Do not touch files unrelated to the issue.
5. If you find out-of-scope problems, mention them in your summary instead of fixing them.
