# Conductor

> Turn GitHub issues into isolated, autonomous coding-agent runs — across **Codex, Claude Code, Antigravity (agy) and Grok**.

Conductor 是一个常驻服务：盯着 GitHub Issues，给每个单子开一个独立工作区，交给编程 agent 去做，做完自动推分支、开 PR、把单子移到人工审核。你管看板，不用盯 agent。

设计参考 [openai/symphony](https://github.com/openai/symphony) 的 [SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)，区别在于：

- **多家 agent**：codex / claude / agy / grok 四个 CLI 都能跑，可按标签指定，也可自动轮转。
- **额度兜底**：某家报限流、容量满、额度用完，就冷却一段时间，同一个工作区立刻换下一家接着做，已有改动都保留。
- **凭证留在宿主**：agent 只在本地提交代码；推分支、开 PR、改标签、写评论都由 Conductor 完成。agent 子进程里会剥掉 `GITHUB_TOKEN` / `GH_TOKEN`。
- **GitHub Issues 原生**：状态用 `state:*` 标签表示，关闭 issue 即完成。

## 工作流程

```
打 conductor 标签的 open issue（Todo）
  → Conductor 认领，改成 state:In Progress，评论“由 X 接手”
  → 建工作区（after_create hook 里 git clone），切到分支 conductor/<号>-<标题>
  → 把 WORKFLOW.md 的 prompt 渲染后交给 agent，多轮续接同一个会话
  → agent 写出 .conductor/result.json
      done    → 推分支、开 PR（Closes #N）、改成 state:Human Review
      blocked → 评论原因、改成 state:Blocked
人审 PR：
  合并 → issue 自动关闭 → 工作区被清理
  要改 → 在 PR 留评论，给 issue 打 state:Rework → 回到原 agent 原会话，带上评审意见继续
```

| 状态 | 怎么表示 | Conductor 会不会处理 |
|---|---|---|
| Todo | open，没有 `state:*` 标签 | 会 |
| In Progress | `state:In Progress` | 会（续做 / 重启后恢复） |
| Rework | `state:Rework` | 会，并带上 PR 评审意见 |
| Human Review | `state:Human Review` | 不会，等人 |
| Blocked | `state:Blocked` | 不会，等人 |
| Closed | issue 已关闭 | 清理工作区 |

可选标签：`agent:claude` 之类指定由哪家处理；`priority:1`…`priority:4` 控制优先级（1 最高）。

## 快速开始

需要 [Bun](https://bun.sh) ≥ 1.3，`gh` 已登录（或设置 `GITHUB_TOKEN`），以及想用的 agent CLI 均已登录。

```bash
git clone https://github.com/BoxiYu/conductor && cd conductor
bun install
cp WORKFLOW.example.md WORKFLOW.md   # 改 tracker.repo 和 hooks.after_create
bun src/cli.ts --check               # 检查配置和各 agent 是否在 PATH 上
bun src/cli.ts                       # 常驻运行，状态页 http://127.0.0.1:4141/
```

其他用法：

```bash
bun src/cli.ts path/to/WORKFLOW.md --once   # 只轮询一次，等派出的任务（含重试）全部结束再退出
bun run build                               # 编译成单文件 dist/conductor
```

状态接口：`GET /api/v1/state`（JSON 快照）、`POST /api/v1/refresh`（立即轮询）。只监听 127.0.0.1。

## 配置（WORKFLOW.md）

和 Symphony 一样：YAML front matter 放运行配置，正文是每单的 Liquid prompt 模板（严格模式，未知变量报错）。模板可用变量：`issue`（`identifier`、`number`、`title`、`description`、`state`、`labels`、`url`、`priority`）、`attempt`（首次为空）、`agent`、`feedback`（Rework 时的评审意见）。Conductor 会在模板后面自动附上交付协议（怎么写 `result.json`），模板里不用写。

完整字段见 [WORKFLOW.example.md](WORKFLOW.example.md)。配置文件修改后自动热加载，只有改 `tracker` 需要重启。

### Agent 接入方式

| Agent | 调用方式 | 续接 |
|---|---|---|
| codex | `codex exec --json …` | `codex exec resume --json <id>` |
| claude | `claude -p --output-format stream-json --verbose` | `--resume <id>` |
| agy | `agy --output-format stream-json -p …` | `--conversation <id>` |
| grok | `grok --output-format streaming-json -p …` | `--resume <id>` |

每轮一个子进程，跑在独立进程组里：卡死、超时或单子被关掉时，连同 agent 起的子命令一起杀掉。会话 ID 存在工作区的 `.conductor/session.json`，重启后接着用。

同一种 CLI 可以配多个实例，比如便宜模型专门处理小单：

```yaml
agents:
  claude-fast: { kind: claude, args: ["--permission-mode", "acceptEdits", "--model", "haiku"], max_concurrent: 3 }
routing:
  default: [claude-fast, codex, claude]
```

## 信任与安全（务必读）

默认参数比较保守，各家只自动接受工作区内的文件修改：

| Agent | 默认参数 |
|---|---|
| codex | `-c sandbox_mode="workspace-write" -c approval_policy="never"`（默认不联网） |
| claude | `--permission-mode acceptEdits`，外加放行列表里的命令（见下） |
| agy | `--sandbox --mode accept-edits`（能改文件，但无头模式下任何 shell 命令都会被拒） |
| grok | `--permission-mode acceptEdits`，外加放行列表里的命令（实测无头模式下连写文件都会被拒，基本需要 `--yolo`） |

默认放行列表（claude 和 grok 会把它们转成 `Bash(<cmd>:*)` 规则）：`git status/diff/log/show/rev-parse/add/commit`，以及只读命令 `ls`、`cat`、`head`、`tail`、`wc`、`pwd`、`grep`，再加上 `verify.commands`。

在 `verify.commands` 里写上项目的测试命令（如 `["bun test"]`）：这些命令会写进提示，并对 claude 和 grok 自动放行。放行列表可以用 `agents.<name>.allowed_commands` 覆盖，规则按前缀匹配，夹带其他命令的组合命令依然会被拒。`git push` 不在放行列表里，推送始终由 Conductor 完成。agent 提交不了也没关系，Conductor 交付前会把未提交的改动替它提交。

**被拒后续接：** grok 在无头模式下遇到没放行的操作，会直接取消整轮；agy 则会跳过那条命令。Conductor 从 stderr 识别出这种情况后，不算失败，而是续接同一个会话，告诉 agent 哪个操作不允许、哪些命令可以用。

**agy 的命令权限：** 按 agy 自己的报错提示，需要在用户级 `~/.gemini/antigravity-cli/settings.json` 里加 `permissions.allow` 规则，写法如 `command(git status)`、`command(bun test)`（这一步未实测）。项目级的 `.agents/settings.json`、`.agents/hooks.json` 里返回 `allow` 的 hook、`--mode auto` 都已实测无效。Conductor 不会改你的用户配置；没有这些规则时，agy 只能改文件，不能自己跑测试和提交（提交由 Conductor 代为完成）。另一种做法是 `--sandbox --dangerously-skip-permissions`：实测 agy 能自己跑测试，但沙箱里仍不能 `git commit`，提交照样由 Conductor 完成。

保守参数下，agent 可能还是装不了依赖、跑不了别的命令。要完全无人值守，就得在 `agents.<name>.args` 里给更大的权限（如 codex 的 `--dangerously-bypass-approvals-and-sandbox`、claude 的 `--permission-mode bypassPermissions`、grok 的 `--yolo`、agy 的 `--dangerously-skip-permissions`）。**这样做之前，务必把 Conductor 放进容器、虚拟机或专用用户里跑**，原因是：

- issue 正文是外部输入，可能藏着诱导 agent 执行恶意命令的指令（prompt injection）。只给可信的人打 `conductor` 标签的权限。
- Conductor 会剥掉 token 环境变量，但如果宿主的 git 凭证存在钥匙串里，agent 依然可以自己 `git push`。真正的隔离要靠容器或独立用户。
- hooks 是可信配置，以完整环境变量执行。

## 开发

```bash
bun test           # 单测 + 调度器端到端（内存看板 + 本地裸仓库 + 假 agent）
bun run typecheck
```

代码结构：

```
src/cli.ts            入口
src/orchestrator.ts   轮询、对账、派单、重试、交付
src/router.ts         选 agent：标签指定 > 续用上次 > 轮转；限流冷却
src/agents/           runner（子进程/超时/卡死检测）+ 四家输出解析
src/tracker/          GitHub Issues 适配器、内存适配器
src/workspace.ts      工作区、hooks、git 分支与推送
src/workflow.ts       WORKFLOW.md 解析与 prompt 渲染
src/server.ts         状态页与 JSON 接口
```

## 路线图

- [ ] 交叉审查：PR 开出后，换一家 agent 审代码，有问题自动打回 Rework
- [ ] 看板 MCP server：让 agent 在宿主端读写 issue，不碰 token
- [ ] 每单跑在容器里（Docker / OrbStack）；按 Symphony 附录 A 支持 SSH 远程 worker
- [ ] codex 改用 `app-server` 长连接
- [ ] 按 agent 统计合并率、返工率和 token 成本，据此调整路由

## License

Apache-2.0。设计参考 openai/symphony（Apache-2.0），未复制其代码。
