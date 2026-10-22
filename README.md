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

### 默认：各家自带的沙箱（`sandbox.mode: native`）

和 Symphony 给 Codex 的配置思路一样：开启每个 CLI 自带的系统级沙箱（macOS 上是 Seatbelt，Linux 上是 Landlock / bubblewrap），沙箱允许的操作一律自动批准。在此基础上，Conductor 还加了一层**禁止读取**，让 agent 读不到凭证文件。

| Agent | Conductor 加的参数 | 跑命令 | 写工作区外 | 读凭证 | 自己提交 |
|---|---|---|---|---|---|
| codex | 自定义权限配置（全盘只读，工作区和临时目录可写，禁止读取的路径设为 `none`），加 `approval_policy="never"` | ✅ | 🚫 | 🚫 | ❌ `.git` 是只读的，由 Conductor 代为提交 |
| claude | `--permission-mode acceptEdits` 加 `--settings`：开启沙箱、沙箱内命令自动放行、禁止跳出沙箱；它自己的读写文件工具另用 `Read`/`Edit` 禁止规则挡住 | ✅ | 🚫 | 🚫 | ✅ |
| grok | 每轮开始前往工作区写入 `.grok/sandbox.toml`（基于 `workspace` 配置，加上 `deny` 列表），加 `--sandbox conductor --always-approve` | ✅ | 🚫 | 🚫 | ✅ |
| agy | `--sandbox --mode accept-edits` | ❌ 所有命令都会被拒 | 🚫 | 🚫 | ❌ 由 Conductor 代为提交 |

上表是在 macOS 上用 Conductor 实际生成的参数测出来的：让 agent 往工作区外写文件，再去读一个放在工作区外的假密钥，然后直接看文件系统和输出结果，不听 agent 自己怎么汇报。

- **禁止读取的路径：** 默认是 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh`、`~/.docker`、`~/.kube`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`，另外每个 agent 都读不到**别家** CLI 的目录（比如 grok 读不到 `~/.codex`）。不存在的路径会自动跳过。可以用 `sandbox.deny_read` 覆盖。
- **网络：** `sandbox.network: true` 时，codex 和 grok 都可以直接联网。claude 的沙箱网络要走代理，只放行 `sandbox.allowed_domains` 里的域名，没填就用内置的常见包仓库列表（npm、GitHub、PyPI、crates.io、Go 代理）；`curl` 这类命令在 claude 里仍会被要求审批，会被拒绝。
- **包缓存：** 沙箱不让写 `~/.npm` 这类全局缓存；如果放开，agent 就可能往缓存里塞恶意包，影响你本机的构建。所以 Conductor 把 npm、bun、yarn、pnpm、pip、uv、Go 的缓存目录都指到工作区里的 `.conductor/cache/`。装依赖能用，只是不共享缓存，会慢一些。
- **agy 是例外：** 它的 `--sandbox` 只限制 shell 命令，管不到它自带的读写文件工具。实测在 `--sandbox --dangerously-skip-permissions` 下，它能写工作区外的文件，也能读到凭证，所以这里不提供自动批准。它在本地只能改代码、不能跑测试；需要它跑测试的话，就放进 Docker 里用 `sandbox.mode: none` 跑。
- **推送：** `git push` 始终由 Conductor 在宿主上完成。agent 子进程里没有 `GITHUB_TOKEN` / `GH_TOKEN`，`~/.config/gh` 也读不到。

**还挡不住的：**
- 读取只禁止了上面这些路径，你项目以外的其他代码目录 agent 依然能读到。
- 网络开着时，agent 理论上可以把它读得到的东西发出去。
- issue 正文是外部输入，可能藏着诱导 agent 执行恶意命令的指令（prompt injection）。只给可信的人打 `conductor` 标签的权限。
- hooks 是可信配置，用完整的环境变量执行，不进沙箱。

### 完全放开：Docker（`sandbox.mode: none`）

`mode: none` 时，Conductor 不加任何权限参数，全由 `agents.<name>.args` 决定，比如 codex 的 `--dangerously-bypass-approvals-and-sandbox`、claude 的 `--permission-mode bypassPermissions`、grok 的 `--yolo`、agy 的 `--dangerously-skip-permissions`。**只能在容器、虚拟机或专用用户里这样跑。** 容器镜像见 `docker/agent.Dockerfile`；Conductor 和容器的对接还在做（见路线图）。

`mode: none` 下还有两个机制会生效：
- **命令放行列表：** claude 和 grok 会把 `agents.<name>.allowed_commands`（默认是只读的 git 命令加 `git add/commit`）和 `verify.commands` 转成 `Bash(<cmd>:*)` 规则。
- **被拒后续接：** grok 在无头模式下遇到没放行的操作，会直接取消整轮；agy 会跳过那条命令。Conductor 从 stderr 识别出这种情况后，不算失败，而是续接同一个会话，告诉 agent 哪个操作不允许、哪些命令可以用。

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
src/sandbox.ts        自带沙箱模式：每家的沙箱参数、禁止读取列表、工作区内包缓存
docker/               完全放开权限时用的 agent 镜像
src/workflow.ts       WORKFLOW.md 解析与 prompt 渲染
src/server.ts         状态页与 JSON 接口
```

## 路线图

- [ ] 交叉审查：PR 开出后，换一家 agent 审代码，有问题自动打回 Rework
- [ ] 看板 MCP server：让 agent 在宿主端读写 issue，不碰 token
- [x] 默认用各 CLI 自带的系统级沙箱，并禁止读取凭证路径
- [ ] 每单跑在容器里（Docker / OrbStack）：镜像已就绪（`docker/agent.Dockerfile`），对接还没做；按 Symphony 附录 A 支持 SSH 远程 worker
- [ ] codex 改用 `app-server` 长连接
- [ ] 按 agent 统计合并率、返工率和 token 成本，据此调整路由

## License

Apache-2.0。设计参考 openai/symphony（Apache-2.0），未复制其代码。
