# 研究模式稳定性整治：修复与验收报告

日期：2026-10-10（Asia/Hong_Kong）  
工作分支：`codex/research-submission-recovery`

## 结论

本轮调查确认的研究输入、停止/恢复、错误清理、重试去重、会话切换与旧事件串状态缺陷已修复，专项回归及隔离桌面测试通过。

仓库后端全量入口仍未达到验收通过：最终复跑在 Office 测试创建符号链接时遇到 Windows `WinError 5`。该限制与下面已经通过的研究专项结果分别记录，未把专项通过当作全量通过。

既有未提交修改、研究历史和用户数据保留。沿用现有依赖、研究算法、调度预算与权限策略；没有数据库表结构迁移，代码保持未提交状态。

## 已修复的行为

### 研究输入与控制

- 控制器和 ingress 共用研究命令解析。`/research resume [RUN_ID] [答案]` 保留答案首词、中文、段落、标点与内部空白；关键字大小写兼容。空答案执行恢复控制而非提交空消息。
- `/stop`、`/research stop`、停止按钮进入原会话的控制路径。显式运行 ID、根会话和工作区按实际归属校验，节点会话不隐式恢复整项研究。
- 停止命令在补充消息等待确认时仍可执行；错误目标或多余参数保留输入并显示提示，避免停错当前研究。
- 等待输入、运行中补充、已失败/停止的恢复和报告追问分开处理。压缩、分叉和树导航保护保留。
- 普通桥接中的研究根会话回复进入同一 durable ingress；同一请求在恢复变为 active 后及桥接重建后，都只执行一次原控制。

### 提交状态、运行状态与重试

- 一条输入失败只更新该输入，后台研究流式状态保留。真正的结束、等待输入通知或可信空闲快照负责清理悬挂的 assistant、流式块与停止状态。
- 超时显示 `unconfirmed`，先核对宿主快照及回执；发送未确认与明确拒绝分开。
- 在现有会话 JSONL 记录 prepared、accepted、applied、rejected、unconfirmed 回执。回执表示输入/控制已投递，不表示模型或整个研究成功。
- 重试使用原 `requestId`、正文、运行标识和参数；对正文、控制动作、limits 与 startNew 的冲突做身份校验。已记录但控制失败的澄清可继续递交，已应用的输入不重复执行。
- 接收确认后的模型/启动异常显示为执行异常；迟到错误不降级已接收的消息。快速重试即使在一次 React 更新中跳过 pending 展示，也会清除旧局部错误。

### 启动取消、重连及会话切换

- 宿主尚未绑定时，以输入请求 ID 取消本次启动；迟到宿主不会绑定或提交原输入，普通会话的 abort 通道保持独立。
- 新研究启动时，上一项已结束研究保留在历史中，但不作为本次启动的停止目标，也不会被轮询误认成新研究创建成功。
- 停止重连先同步新宿主及 stream，再发送带身份关联的控制；ACK 后维持“停止中”，直到实际终态到达。兼容快照缺少 streamId 时保留当前流身份。
- session、stream、序号和创建请求相关联；旧 discipline 通知不覆盖已建立的运行归属。
- 切换普通会话、新建、同路径重开及切换项目退出研究视图并保留后台研究/卡片。研究提交尚在等待时，普通会话输入仍可使用。
- 招募未结束时有明确的可重试错误出口；研究宿主的角色、模型绑定和原会话状态按现有机制恢复。

## 最终验证结果

| 验证层级 | 实际结果 | 证据范围 |
|---|---|---|
| 前端完整 Vitest | **64 文件、557 项通过** | 输入、设置、普通/研究会话、状态恢复与界面回归 |
| 后端研究专项 | **224 项通过** | 12 个相关测试文件；桥接、回执、重放、取消、恢复、只读连接及归属保护 |
| 真实原生子 Agent | **1 项通过** | 原生子进程、localhost 模型协议、团队模型绑定与资源释放 |
| 真实 Electron + Python + localhost 模型协议 | **3 项通过** | 多段中文原文、模型错误同 ID 重试、resume 首词、错误停止目标、等待输入停止、原会话重开及终态报告保留 |
| 浏览器 E2E（Mock bridge） | **4 项通过** | 研究菜单、窄屏、补充/澄清/追加、最终报告导出 |
| TypeScript / Oxlint / 生产构建 | **通过** | 构建有既有大 chunk 提示 |
| 定向 Ruff / diff 检查 | **通过** | 保留既有 TRY004 的 ValueError 接口契约；没有 whitespace 错误 |
| 后端全量入口 | **未通过** | 首失败停止复跑：296 passed、1 skipped 后，Office 符号链接测试失败 |

原生子 Agent 测试曾在固定 30 秒窗口内超时。测试现复用项目既有的原生分阶段验收界限：真实模型请求前最多 45 秒，之后响应/退出仍为 20 秒。串行复验 34.27 秒通过；生产研究预算未因此更改。

并发运行原生测试时还观察到一次研究宿主冷启动超时；同版代码串行重验 Electron 三项全部通过。没有将这次失败隐藏为成功，负载下的冷启动性能仍可继续观察。

## 全量入口的限制

最终全量诊断命令使用首失败停止，以明确当前阻塞点：

```powershell
& 'C:\frontend-research\Misaka-Agent\.venv\Scripts\python.exe' -m pytest 'C:\frontend-research\Misaka-Agent\tests' -q -x --tb=short -o faulthandler_timeout=90
```

失败用例：`test_archiving_never_fails_the_write_that_succeeded`。失败发生在测试自身的 `Path.symlink_to`，返回 `PermissionError: [WinError 5]`，尚未进入该用例要验证的 Office 写入逻辑。该测试及仓库 conftest 未在本轮改动中重写。

这次全量入口在首个失败处结束，之后的仓库用例不计入全量通过；研究专项的 224 项另行完整运行并通过。

## 验证边界与使用

- Python 测试使用隔离 MISAKA_HOME；Electron 使用临时 home、workspace 与 user-data，模型协议服务只监听 localhost。
- 没有调用真实第三方模型 API，也没有消耗真实模型额度。
- 真实 Electron 验证覆盖启动、等待输入、恢复、错误重试、停止、历史重开；完整最终报告导出由 Mock bridge 的浏览器用例验证。复杂多节点研究的最终 adjudication 尚未在同一个真实 Electron 用例中完整走完。
- 最新独立审查中，已确认的输入归属、停止目标、旧事件覆盖、fresh-start 绑定及普通入口重放问题均已闭环。
- 重启桌面端后加载新 Python 桥接与前端代码。若仍有错误，可用同一个 requestId 的前后端元数据关联定位；诊断日志继续排除正文、附件和认证信息。

前端复验入口：

```powershell
Set-Location 'C:\frontend-research\Misaka-Agent\desktop'
pnpm exec vitest run --config vitest.config.mts --maxWorkers=2 --minWorkers=1
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright test --config playwright.electron.config.ts electron-research-runtime.spec.ts --workers=1
pnpm exec playwright test research-workflow.spec.ts research-mode.spec.ts --workers=1
```

## 多分支审计与整合（同日第二轮）

### 仓库结论

- 本地 4 个分支：`main`、`codex/sync-0.18.11`、`codex/research-submission-recovery` 同指 `7bf6b1d`；`codex/backup-pre-0.18.11-20261008`（`562e55f`）已由合并提交 `7336ce8` 完整进入 `main`，合并只改写其 2 个文件的版本号，无遗留功能。不存在需要跨分支取舍的竞争实现——待整合的是本分支工作区里那批未提交成果。
- `main` 领先 `origin/main`（`3bcf7a3` = `v0.18.11`）12 个提交且从未推送；`origin` 是上游公开仓库，推送与否是单独的决定。
- 仓库是 shallow（`.git/shallow` 边界 `98862e7`）：`v0.18.4`/`v0.18.5` 在 git 视图里"不可达于 main"。未来同步上游前需先 `git fetch --unshallow`，否则 `merge-base` 在边界以下失真。
- `git stash list` 为空，但对象库里有 4 个当日 16:50、16:52 的不可达限量 stash 提交。逐 blob 比对：三处差异全部是被工作区取代的早期写法（更松的 streamId 容忍、会误判接受的快照折叠、按 runId 去重的迟到归属），独有成果为零。

### 保护措施

- `refs/protect/wip-20261010`：`git stash create --include-untracked` 快照，与工作区 43 文件 +3236/−290 逐字节一致。
- `refs/protect/stash-1650`、`refs/protect/stash-1652`：把即将被 gc 的限量 stash 固化。
- `C:/frontend-research/backups/misaka-refs-20261010.bundle`：`git bundle verify` 通过，含 4 个分支、8 个标签与上述保护引用。
- `C:/frontend-research/backups/misaka-wip-20261010/`：`tracked.patch` + 23 个未跟踪文件 + `manifest.sha256`，不依赖 git 对象库。

### 本轮修复

后端

- `misaka/core/agent_session.py`：投递标识改在用户消息真正落盘时（`_persist_message`）登记，删除启动前的预登记。此前一次在写入之前抛错的回合会把 `deliveryId` 永久留在去重集合里，同 `requestId` 重试命中早退、回报成功却什么都没投递，回执还被写成 `accepted`。
- `misaka/core/research/ingress.py`：重放时用回执当前的 `runId` 重建 ack（原样回放的 ack 写于 `prepared` 时，那时 `runId` 还是空）；三处 requestId 冲突改用 `submissions.request_conflict()`，返回 `RESEARCH_REQUEST_CONFLICT` 且 `retryable=false`，不再以裸 `ValueError` 被桥接层译成"可重试"而诱发重复投递。
- `misaka/core/research/submissions.py`：`text_fingerprint` 容忍孤立代理对（原先在写回执之前就 `UnicodeEncodeError`）；诊断构建号读不到源码时回落 `unknown`；`public_receipts` 为 `rejected`/`unconfirmed` 输出按 errorCode 查表的固定 `error` 文案，与前端 `ResearchHostSnapshot.submissionReceipts[].error` 契约对齐，不含正文与第三方异常文本。

前端

- `useSessionStore.ts`：从历史或运行胶囊打开研究属用户主动意图，绑定走 `force` 入口，不再被"退役绑定"栅栏永久挡住（自动事件的重绑仍受栅栏保护，避免旧宿主劫持当前转录）；`unconfirmResearchMessage` 对仍可重试的输入交还创建栅栏并落地 `deliveryReconciled`，超时核对完成的输入不再停在"正在核对研究记录…"且没有任何重试出口。后端明确 `retryable=false` 时栅栏保留，维持"结果未知就不许再开第二个 run"的既有约定。
- `startComposerResearch.ts`：重试沿用原封套里的 `startNew`，不再把上一个已结束的 run 认作本次问题的 run（那会跳过启动确认并把新问题折进旧 run）；宿主核对完成后回传 `reconciled`。
- `useSettingsStore.ts`：研究会话内做出的模型选择带上会话标识，另一个会话的绑定不再被上一路待提交选择压住；普通模式的选择仍按原设计带入研究（`desktopResearchTeam.test.ts` 记录的正是该意图）。
- `Composer.tsx`：最近投递态的 selector 改为反向单趟查找，不再每次 store 变更复制整个消息数组。
- `ToolCallCard.tsx`：展开态"参数"以入参是否存在为准，嵌套对象入参（常见于 MCP 工具）不再显示为空。
- `desktop/e2e/desktop-research-team.spec.ts`：`getByRole('status')` 与新增的"已记录"投递状态行构成 strict mode 冲突，断言改为按文案过滤该错误状态区。

### 复核后否决的审查意见（未改代码）

- `desktop_bridge.py:1517` 的 `con`：`ingress.session_run()` 首行就是 `if con is None: return None`，取消路径不会 `AttributeError`，不加无意义守卫。
- `.conversation-group-duration`：同一元素带 `.conversation-row-meta`，样式已存在，后者只是测试锚点。
- 重试按钮的 `hover:bg-surface-2`：与 `CodeBlock`、`ResearchFinalReport`、`ResearchHistoryDialog` 等既有控件一致，属项目现行约定，单点改写反而不一致。
- `submissions.trace_input/trace_failure` 的 `logger.warning`：根 handler 坐在 WARNING（`misaka/config/engine.py`），降为 debug 会让研究提交重新变得无痕可查。

### 本轮验证结果

| 层级 | 实际结果 |
|---|---|
| 前端 Vitest 全量 | 64 文件、561 项通过（较上轮 +4 项，均为本轮回归用例） |
| TypeScript / Oxlint / 生产构建 | 通过；构建仍提示既有大 chunk |
| 后端研究相关 9 个文件 | 172 项通过 |
| `tests/test_desktop_team_runtime.py` | 25 项通过；`test_real_native_agent_child_…` 与同文件用例同跑时 `WinError 5`，单独跑 25.06s 通过——本机 spawn 资源竞争，非回归 |
| 真实 Electron + Python + localhost 模型协议 | 3 项通过：同 `requestId` 重试不重复原意图、resume 保留首词、`waiting_input` 停止归位 |
| 浏览器 e2e 全量（Mock bridge，82 项、workers=1） | 81 项通过、1 项跳过、1 项失败：`e2e/modelPicker.spec.ts`“two-stop max…”，即下述既有红，与本次整合无关 |
| 定向 Ruff、`git diff --check` | 通过 |
| 后端全量 pytest | 本轮未跑：本机约 125 项 `WinError 5` 环境噪声（`os.symlink`、`uv run`、`spawnSync powershell`），与研究模式无关 |
| 真实第三方模型 API | 未调用、未验证 |

### 仍未闭环

- `ingress.py` 的 `current_request_id` contextvar 仍被跨任务读取：向运行中的回合 steer 时，`research-question` 落盘与 `applied` 迁移可能被贴上上一个请求的 id（重复创建仍由 `ingress.py:261-266` 挡住）。彻底修法是把 requestId 随 `pending["choice"]`/事件显式传递，涉及引擎装配路径，按本轮风险预算未动。
- 原现场“Enter prose in this research conversation.”仍缺同一 requestId 的请求与 ack，现场因果链未闭环。
- `researchDiagnostics` 前端环形缓冲目前只写不读，尚无导出或 IPC 通道。
- 浏览器 e2e 的 `e2e/modelPicker.spec.ts`“two-stop max…”为既有红（`ThinkingSlider.tsx` 的 `hint` 把 `modelDefault` 排在 `isFallback` 之前），与本次整合无关。
