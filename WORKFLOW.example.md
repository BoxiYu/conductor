---
# Copy to WORKFLOW.md (ideally inside the target repo) and adjust.
tracker:
  kind: github
  repo: OWNER/NAME                 # issues of this repo are the work queue
  required_labels: [conductor]     # only issues with every label here are picked up
  state_label_prefix: "state:"     # state lives in labels like `state:rework`
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Closed]        # closed issue = done; its workspace is removed
  # Linear instead (branches and PRs still go to `repo` on GitHub):
  # kind: linear
  # team: PY                       # Linear team key; needs $LINEAR_API_KEY
  # project: ""                    # optional project name filter
  # active_states: [Todo, In Progress]
  # review_state: In Review        # must exist in the team's workflow
  # blocked_state: Blocked
  # terminal_states: [Done, Canceled, Duplicate]

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

sandbox:
  # native: each CLI runs in its own OS sandbox (Seatbelt / Landlock) and auto-approves what
  #         the sandbox allows: read anywhere except deny_read, write only the workspace + tmp.
  # none:   Conductor adds no permission flags; agents.<name>.args decide (e.g. in Docker).
  mode: native
  network: true                 # commands may use the network (claude: allowed_domains only)
  # allowed_domains: ["registry.npmjs.org", "github.com"]   # claude; empty = built-in list
  # deny_read: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.docker", "~/.kube",
  #             "~/.netrc", "~/.git-credentials", "~/.npmrc"]   # default; other agents' homes are added
  # allow_write: []             # extra writable paths; package caches already live in the workspace

verify:
  # Commands the agent should run to check its work. They are listed in the prompt.
  commands: ["bun test"]

handoff:
  open_pull_request: true
  draft: false

server:
  port: 4141

agents:
  # args are appended after the sandbox flags, e.g. a model choice.
  codex:
    max_concurrent: 2
    # args: ["--skip-git-repo-check", "-m", "gpt-6-sol"]
  claude:
    max_concurrent: 2
    # args: ["--model", "opus"]
  agy:
    max_concurrent: 1
    # In native mode agy can edit files in the workspace but every shell command is refused:
    # its --sandbox does not cover its own file tools, so auto-approving would let it read and
    # write anywhere. Conductor commits for it. For tests, run agy with sandbox.mode: none in Docker.
  grok:
    max_concurrent: 1
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
