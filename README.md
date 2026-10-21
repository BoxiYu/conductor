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
bun src/cli.ts path/to/WORKFLOW.md --once   # 只轮询一次，等派出的任务跑完再退出
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
| claude | `--permission-mode acceptEdits` |
| agy | `--sandbox --mode accept-edits` |
| grok | 无（需要审批的工具会被拒绝） |

保守参数下，agent 可能跑不了测试或装不了依赖。要完全无人值守，就得在 `agents.<name>.args` 里给更大的权限（如 codex 的 `--dangerously-bypass-approvals-and-sandbox`、claude 的 `--permission-mode bypassPermissions`、grok 的 `--always-approve`）。**这样做之前，务必把 Conductor 放进容器、虚拟机或专用用户里跑**，原因是：

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
