# 研究界面卡死、可靠退出与子 Agent 执行详情 — 实施计划与进度

状态：**已完成任务一至四的代码、单测与真实 Electron 验收；两项能力明确保持未完成（第 10 节 1、2 条）**
最后更新：2026-10-11 02:35（本机时钟）
执行方：Qoder agent（非 Codex 工具链）
仓库根目录：`C:\frontend-research\Misaka-Agent`

约束（用户指定，全程生效）：不自动提交或推送；不清理真实研究数据（`~/.misaka`、`.misaka` 仅读）；不自动重发真实研究；未经验证的项目保持未完成。

---

## 1. 目标

1. 研究启动、招募、子任务执行期间界面保持可操作（滚动、展开工具、输入、切换界面）。
2. 渲染线程整体卡死时，仍能通过应用自身停止并退出（不依赖渲染线程）。
3. 子任务抽屉展示真实执行记录：命令、参数、输出、错误、实际时间。

---

## 2. 基线复核（自行执行，不引用上一轮结论）

`git status`：工作区干净（`main`，领先 `origin/main` 18 提交；`origin` 是上游公开仓库，按约束不推送）。

| 命令 | 结果 | 判读 |
| --- | --- | --- |
| `pytest` 计划指定的 4 个文件 | **39 passed, 2 failed** (84.71s) | 与上一轮"27 passed, 1 failed"不同 |
| `pytest tests/test_desktop_research_stop_settle.py -q` | **1 passed** (13.97s) | 合并跑的 `stopping != stopped` 属负载假失败 |
| `pytest "...test_real_native_agent_child_uses_desktop_bootstrap_and_exact_team_pair" -q` | **1 passed** (22.00s) | 同文件兄弟用例挤占资源导致假失败；本轮未复现 `WinError 5` |
| `pnpm test`（64 文件） | **560 passed, 1 failed** (160.66s) | 失败项 `Sidebar.test.tsx` 5s 超时 |
| `npx vitest run src/components/Sidebar/Sidebar.test.tsx` | **5 passed** (11.91s) | 同负载假失败 |
| `ruff check misaka tests` | **791 errors** | 既有基线红：665 条 F401 集中在 `misaka/core/documents/pageindex/flash/**`（vendored，未进 `extend-exclude`）。本轮不修，但要求自身改动零新增 |

结论：研究模式子集与前端单测**单独运行均绿**；`ruff` 基线 791 错作为已知基线失败记录，不计入全绿。

---

## 3. 卡死根因：证据

### 3.1 故障会话（只读真实数据）

`~/.misaka/state/sessions/last-order/--c-agent-09dbf…--/2026-10-10T13-33-18-042Z_01a12604-….jsonl`（39 行 / 267,269 字节；文件名 UTC，本地 +8）

| 本地时间 | 条目 | 规模 |
| --- | --- | --- |
| 21:33:38 | assistant：2 × `read` | 参数 32 / 49 字节 |
| 21:33:38 | 2 × toolResult | 3,678 / 11,696 字符 |
| **21:33:57** | assistant：文本 96 字符 + **6 × `desktop_recruit_agent`** | 参数 **2,221/2,327/2,086/1,850/2,183/2,173** 字节（≈13.3 KB） |
| 21:34:06 | 6 × toolResult | 4 条 47–63 字符、2 条 2,349 / 2,339 字符 |
| 21:34:15 | assistant：**2 × `desktop_recruit_agent`（修正重试）** | 2,186 / 2,176 字节 |
| 21:36:16 | assistant：`misaka_research_assign` | **参数 17,274 字节** |
| 21:37:20 | assistant：`misaka_research_assign` | 参数 2 字节；日志 `Responses stream ended before response.completed` |

截图里的"招募 0/6"即 `ExecutionGroup` 的 `已完成 0/6`；后端 9 秒后已取回全部结果，前端却失去响应。

### 3.2 链路事实

- `misaka/agent/types.py:341` `MessageUpdateEvent.message: AgentMessage` + `misaka/cli/desktop_bridge.py:_serialize_event`：**每个 `message_update` 都携带整条已累积消息**（全量快照）。
- `misaka/cli/desktop_bridge.py:1219` `session.subscribe(handle_event)`：每事件一行 stdout，无合并、无节流。
- `misaka/core/network/dispatch.py:46` 注释给出量级旁证：一次真实 sweep 有 46,000 条 `message_update` / 22 MB。
- `desktop/electron/main.ts` `dispatchResearchMessage`：每行一次 `webContents.send`。
- `desktop/src/store/useSessionStore.ts` 旧 `handleResearchBridgeMessage`：每条消息一次 `set()` → 一次渲染。
- `desktop/src/components/Timeline/Timeline.tsx` 旧实现：`useLayoutEffect(reconcile, [messages])` + `ResizeObserver(reconcile)`，每次都 `querySelectorAll(LANDMARKS)` 并逐个 `getBoundingClientRect()`。

### 3.3 复现与 CPU profile（任务一交付）

复现载体：`desktop/e2e/researchRecruitmentFixture.ts` + `desktop/e2e/electron-research-freeze.spec.ts`（真实 Electron、真实研究宿主、本地伪造 provider，无个人账号）。

- 真实链路一次运行（paced，221+76+8 个 SSE 事件）：宏任务延迟 p50 1ms / p95 3ms / max 84ms，rAF max 238ms，展开、输入、滚动、界面切换全部可用 → **该速率下不复现卡死**。
- 同一链路上注入 20 轮"录制形状"的招募消息（每轮 ≈1.41 MB、约 900 条全量快照，`chunkChars=16` 单批 IPC）：**宏任务 p95 689 ms（> 计划阈值 500 ms）、max 885 ms**，即突发到达时界面失去响应能力被复现并量化。
- CDP CPU profile（第 4 轮，采样间隔 0.5 ms，总 1,744 个样本 / 2,539 ms 窗口，空闲仅 733 ms ≈ 29%）自耗时排名：

| 自耗时 | 函数 | 归属 |
| --- | --- | --- |
| 733 ms | `(idle)` | — |
| **233 ms** | `querySelectorAll` | `Timeline.rememberAnchor()` 的 `LANDMARKS` 全量扫描 |
| 205 ms | `(anonymous) index-*.js:639` | Streamdown/markdown 解析（构建产物内） |
| 169 ms | `(program)` | 引擎/事件循环 |
| 103 ms | `(anonymous) index-*.js:641` | `MessageItem` 渲染体 |
| 58 ms | `r index-*.js:508` | 组件/摘要渲染 |
| **38 ms** | `getBoundingClientRect` | 同一锚点扫描的布局读取 |
| 41 ms | `(garbage collector)` | 快照对象洪流 |

**结论（可复现、可数值化）：**卡死不是某一个 bug，而是**链路无任何合并/预算**导致的渲染线程饱和：`message_update` 每 token 全量快照 → 每事件一次 store 提交与 React 渲染，且每次消息变化都触发一次覆盖整个已挂载视口的 `querySelectorAll + getBoundingClientRect` 布局遍历。突发到达时（真实网络缓冲会产生），主线程持续忙、输入排在队列后面，用户看到"整个界面失去响应"，而后端仍在推进。

`querySelectorAll + getBoundingClientRect` ≈ 271 ms / 1,806 ms 忙时间（15%）是**单一最大可指认热点**；事件洪流是乘数。两者都在任务二处理。

仍未取得的一点：故障当时（21:33–21:40）没有诊断日志，无法给出那一次的确切栈；本轮结论来自同一链路的受控复现 + profile，不是对历史现场的推断。

---

## 4. 任务分解与实施

### 任务一：生产环境复现与诊断闭环 — 代码完成，验收进行中

- [x] 基线与 `git status`（第 2 节）
- [x] 真实故障会话取证（第 3.1 节，只读）
- [x] 链路事实核对（第 3.2 节）
- [x] 构建标识以内容哈希记录，启动方式核对：`pnpm build` → `dist-electron/main.js` `9116d52b0199`、`preload.js` `805fe346b70d`、`dist/index.html` `0c3550c1a7a3`、renderer chunk `index-Yw6jPyGv.js` `a4218c6fd4fe`（1,424,380 字节）、`misaka/cli/desktop_bridge.py` `5c733dcbb38f`；生产加载路径 `main.ts` 无 `VITE_DEV_SERVER_URL` → `loadFile(dist/index.html)`，preload 依次探测 `preload.cjs/mjs/js`
- [x] 脱敏确定性招募 fixture：`RECRUIT_ARG_BYTES = [2221,2327,2086,1850,2183,2173]`、`INVALID_CALLS = [1,3]`、重试 `[2186,2176]`、规划 `17,274` 字节；文本全部由确定性 filler 生成，无真实课题
- [x] 真实 Electron → preload → research bridge → store → Timeline 投递：真实链路（伪造 provider）+ 注入链路（`webContents.send('research:event')`，带 `mainSentAt`/`mainBytes` 印章）
- [x] 有界诊断记录：`desktop/electron/diagnostics.ts`（主进程：`bridge:window` 聚合、逐条非 `message_update` 事件身份、`window:unresponsive/responsive/render-gone/load-failed`、`shell:start` 构建标识、`close:*` 状态迁移）；`desktop/src/lib/rendererDiagnostics.ts`（渲染侧：`renderer:stream` 聚合窗口、`renderer:longtask`、`renderer:input-delay`、`renderer:error`，经 preload `diagnostics.report` 回传）
- [x] 轮转与上限：单文件 2 MiB、总量 10 MiB、保留 14 天、字段裁剪 200 字符 + 凭据形状替换为 `[redacted]`；目录经 home 治理声明：`misaka/config/home.py` 新增 `desktop_diagnostics = Entry("logs/desktop-diagnostics","logs")`，两侧一致性由 `tests/test_desktop_diagnostics_home_row.py` 钉住（3 passed）
- [x] 根因报告：第 3.3 节
- [x] 每次复现同时执行输入、滚动、工具展开、界面切换四项探针（spec 内 `probeInteractions`，读数见第 6 节）

### 任务二：修复已证实的前端卡死触发点 — 代码完成，阈值验收进行中

- [x] 最小复现先稳定失败：注入 20 轮的 `macroP95 = 689 ms` 已越过计划阈值 500 ms，spec 断言据此失败
- [x] **有时间预算的顺序处理**：`desktop/src/lib/researchEventIngest.ts`（新）
  - 每片最多 8 ms，随后 `setTimeout(0)` 主动让出事件循环；顺序严格按到达序
  - 只合并"整条消息的 assistant 全量快照"（`snapshotKey` 要求 `sessionId|streamId|timestamp` 相同且与队尾相邻）；**终态、ack、`tool_execution_start/update/end`、`agent_settled`、`desktop-team` 一律保留**
  - 增量文本（无全量快照的 `message_update`）永不合并、永不丢弃
  - 超限时只丢弃"已被更晚同键快照取代"的项
  - `flushNow()` 供读取历史前对齐状态；ack 走同步路径不排队
- [x] store 接线：`ingestResearchBridgeMessage`（ack 立即、事件入队）+ `flushResearchIngest`；`App.tsx` 订阅改为 ingest
- [x] **布局/滚动循环**：`Timeline.tsx` 尺寸变化与消息变化协调到**单次动画帧**（`scheduleReconcile`）；`following` 时不再全量扫描锚点，只写回 `scrollTop`；点击/滚动捕获合并；用户手动上滚的锚点仍**立即**采集（不被延后一帧，否则会把扩张后的位置当成阅读锚点）
- [x] 参数摘要热点：`toolCallSummary` 的脱敏窗口限制为 `MAX_DETAIL * 8 = 2560` 字符（展示上限 320，可见输出不变），避免每次快照对整段大参数跑两条正则
- [x] 校验失败只结束对应调用：回归测试覆盖（`兄弟调用继续正常更新`）
- [x] 保持 `sessionId`/`streamId`/`seq` 隔离：旧流/重复 seq 不覆盖当前会话（测试覆盖）
- [x] 不串行、不加等待：六角色并行与招募超时未改
- 已验证：`researchEventIngest.test.ts` 12 passed、`store/__tests__/researchIngestSlices.test.ts` 6 passed、`conversation.test.tsx` 23 passed（含新增"一帧只读一次锚点"）、`toolDisplay`/`executionTimeline` 无回归
- [x] 生产构建 Electron 下阈值通过：20 轮连跑 p95 23 ms / max 94 ms / 0 次 >2 s 停顿；展开与阅读位置在后续事件中保留（spec 断言）

### 任务三：独立于渲染线程的关闭兜底 — 代码 + 单测完成，Electron 验收进行中

- 新状态机 `desktop/electron/closeFlow.ts`：`idle → awaiting-renderer → renderer-dialog | native-dialog → stopping → exited`，取消回 `idle`，后台继续回 `idle` 且隐藏窗口
- 协议：主进程 `app:request-close {closeRequestId}`；渲染进程 DOM 提交后 `app:close-presented`；对话框被关而不做选择时 `app:close-cancelled`；`app:confirm-close` 本身视为"页面活着"
- 1.5 s 未确认或窗口已判定 `unresponsive`/`render-process-gone` → 原生框：研究进行中 `['停止并退出','后台继续','取消']`，否则 `['退出','取消']`
- 停止 > 5 s → 二次原生框 `['继续等待','强制退出','取消关闭']`；强制退出用 `taskkill /PID <pid> /T /F` **仅针对本应用启动的普通桥接与研究桥接及其子树**，3 s 内核实退出，失败则原生错误框且不谎报成功
- 重复关闭复用当前流程；迟到确认与旧 `closeRequestId` 只记录 `close:stale-presented/stale-canceled`，不再弹窗或退出
- `researchActive()` = 渲染进程上报的 active **或** 主进程自己的在途请求（`researchWaiters`）**或** 启动尚未拿到标识（`researchStarting`，含渲染进程上报的 `pendingStart`）——不再单纯依赖最后一次 `researchActive` 通知
- 生命周期统一：`releaseResearchWaiters()` 注销计时器与待响应请求；`stopBridgeProcess()` 与 `stopResearchBridge()`/`forceTerminateOwnedProcesses()` 共用 `waitForChildExit`/`terminateProcessTree`；`app.on('quit')` 落 `app:quit` 记录并 dispose
- 测试：`electron/closeFlow.test.ts` **16 passed**（正常确认、未确认兜底、unresponsive 直落原生、重复关闭、迟到确认、后台继续、取消、升级强退、继续等待、清理失败不谎报、无研究时的两键框、页面退出/隐藏、对话框取消后可再次关闭、`skipRenderer` 直连、dispose 释放等待）
- 渲染侧回归：`App.close.test.tsx` **5 passed**（提交后确认、取消上报、tray/quit 自动确认、pendingStart 上报、卸载退订）
- [x] 真实 Electron 忙循环验收 `e2e/electron-close-fallback.spec.ts`：**6 passed**，全部从主进程调用窗口关闭；"Python 永不退出"的强退分支由 `closeFlow.test.ts` 的 force/cleanup-failure 用例覆盖（端到端只跑到协作停止，见第 10 节）

### 任务四：接入真实子 Agent 执行记录 — 代码 + 单测完成，端到端待补

接口 `get_research_execution`：`sessionId, runId, taskId, instanceId?, cursor?, limit(1..100，默认 100)` →
`{ instances, entries, nextCursor, hasMore, availability, reason, runId, taskId, instanceId }`；
每条记录 `instanceId/toolCallId/toolName/status/arguments/partialOutput/result/error/startedAt/endedAt/recordIndex`。

- 服务端 `misaka/core/research/desktop_view.py`：`execution_instances`（`task_runs` 行按 generation/attempt 排序；无 run 行时退回卡片自身的 `agent_id`/`session_file`）+ `execution_detail`（先校验 run 存在且 `research_run_tasks` 关联该 task，否则返回 `None`）；路径只由服务端从记录解析（`home.from_stored`），**请求不接受任意文件路径，响应不回传路径**（测试断言响应文本中不含该路径）
- 桥接 `misaka/cli/desktop_bridge.py`：新分支复用 `_open_research_readonly()` 与 `_research_workspace()` 归属门；异工作区/异研究 → `execution: null`，不谎报空成功
- 游标：以记录在转录中的稳定条目位置 `recordIndex` 为游标；`load_entries_from_file(strict=False)` 天然跳过尾部未写完的一行，下次刷新重试
- 上限：单字段预览 32 KiB、单响应 256 KiB、每页 ≤ 100；超限标记 `argumentsTruncated`/`resultTruncated`，由"继续读取后续记录"按需翻页
- 脱敏：参数、结果、错误、实例摘要统一走 `misaka.utils.redact.redact`（不只参数摘要）
- 状态：`available / not_started / missing / interrupted` 各带 `reason`；实例结束仍有未回答调用 → `interrupted`
- 前端：`desktop/src/types/research.ts` 新增执行类型；`desktop/src/lib/researchExecution.ts` 把记录投影成既有 `ToolCallRow`（复用展开组件）；`ResearchTaskDrawer.tsx` 的占位文案已删除，新增实例选择、命令行、参数、输出、错误、实际时间
- 轮询：仅抽屉打开且实例运行中每 2 s；`inFlight` 保证不重叠；切换/关闭即停；`owner` 令牌丢弃过期响应；展开状态走 `useDisclosure`（按 `tool:${id}` 持久），刷新不覆盖阅读状态
- 时间缺失显示"时间未记录"，缺日志显示具体原因，不伪造耗时/命令/输出
- 测试：`tests/test_desktop_research_execution.py` **8 passed**（真实命令与结果、凭据不外泄、游标翻页、not_started/missing、interrupted、异研究读不到、无实例、桥接 ack 与归属门）；`ResearchTaskDrawer.test.tsx` **9 passed**（真实记录、展开参数、缺失状态、错误与时间未记录、2 s 轮询不重叠、终态停止轮询、切换后丢弃迟到响应、按需翻页、关闭即静默）
- [ ] `desktop_run_member` 辅助任务从工具结果 `agentId` 进入同一投影：未实施（当前抽屉入口是正式卡片；成员辅助任务仍只有 `instances` 标识，服务端校验"属于当前团队"需要团队文件解析，未做，保持未完成）

---

## 5. 修改文件清单（本轮）

新增：
- `desktop/electron/diagnostics.ts` / `diagnostics.test.ts`
- `desktop/electron/closeFlow.ts` / `closeFlow.test.ts`
- `desktop/src/lib/rendererDiagnostics.ts` / `rendererDiagnostics.test.ts`
- `desktop/src/lib/researchEventIngest.ts` / `researchEventIngest.test.ts`
- `desktop/src/lib/researchExecution.ts`
- `desktop/src/store/__tests__/researchIngestSlices.test.ts`
- `desktop/src/components/Timeline/__tests__/ResearchTaskDrawer.test.tsx`
- `desktop/e2e/researchRecruitmentFixture.ts`
- `desktop/e2e/electron-research-freeze.spec.ts`
- `desktop/e2e/electron-close-fallback.spec.ts`
- `tests/test_desktop_research_execution.py`
- `tests/test_desktop_diagnostics_home_row.py`
- 产物：`desktop/preview-artifacts/research-freeze/{freeze-report.json,burst-cpu-profile.json}`

修改：
- `misaka/config/home.py`（`desktop_diagnostics` 行）
- `misaka/core/research/desktop_view.py`（执行实例与分页投影）
- `misaka/cli/desktop_bridge.py`（`get_research_execution`）
- `desktop/electron/main.ts`（诊断、关闭状态机、构建标识、生命周期）
- `desktop/electron/preload.ts`（`diagnostics.report`、`closeRequestId` 协议）
- `desktop/electron/researchBridge.ts`（删除已被状态机取代的 `researchCloseOutcome`）
- `desktop/src/types/global.d.ts` / `types/research.ts`
- `desktop/src/App.tsx`（ingest 订阅、pendingStart、关闭确认协议）
- `desktop/src/main.tsx`（安装渲染侧诊断）
- `desktop/src/lib/researchBridge.ts`（到达计时）
- `desktop/src/store/useSessionStore.ts`（ingest 队列）
- `desktop/src/lib/toolDisplay.ts`（脱敏窗口）
- `desktop/src/components/Timeline/Timeline.tsx`（单帧几何、锚点预算）
- `desktop/src/components/Timeline/ResearchTaskDrawer.tsx`（真实执行记录）
- `desktop/src/App.close.test.tsx`、`desktop/electron/researchBridge.test.ts`、`desktop/src/components/Timeline/__tests__/conversation.test.tsx`、`desktop/electron/main.theme.test.ts`（随协议与单帧化更新）、`desktop/e2e/electron-workflows.spec.ts`（关闭段改到新契约）

---

## 6. 修复前后对照（同一 spec、同一生产构建、真实 Electron）

| 指标（宏任务调度延迟，ms） | 修复前 | 修复后 |
| --- | --- | --- |
| 真实链路（paced，221+76+8 个 SSE 事件）p50 / p95 / max | 1 / 3 / 84 | 1 / 2 / 86 |
| 注入 20 轮招募消息 p50 / p95 / max | 1 / **689** / **885** | 1 / **23** / **94** |
| 每轮负载 | ≈900 条 / 1.41 MB | **848 条 / 5.09 MB**（负载提高到 3.6 倍） |
| > 2 s 单次停顿 | 0（但 p95 已越过 500 ms 阈值 → spec 失败） | 0，p95 阈值通过 |
| 交互探针（真实链路） | — | 输入 174 ms、滚动 20 ms、展开 180 ms、界面切换 465 ms |
| profile 忙时间构成（单个 profiled 轮） | `querySelectorAll` 233 ms + `getBoundingClientRect` 38 ms / 忙 1,806 ms（空闲仅 29%） | 空闲 1,056 ms；`querySelectorAll` 已不在前十，最大真实项 `(program)` 79 ms |

诊断闭环读数（修复后，`renderer:stream` 每 2 s 窗口）：`received ≈ 1,700`、`applied 12–21`、`merged 8–10`、`queue 0`、`maxApplyMs ≤ 9.1`、`bytes ≈ 10.2 MB/2s` —— 即洪流确实按生产形状到达（10 MB / 2 s），但被合并 + 预算消化掉，前端队列没有堆积。

`bridge:window` 同期读数：`received/sent` 与 `maxBytes 18,213`（一条 `message_update` 的最大行 ≈18 KB，与第 3.1 节的 17,274 字节规划参数一致）。注意 `dropped` 目前把"缓冲满 300 条后裁剪旧项"也计成丢弃，是诊断字段语义上的粗糙处（不影响功能），记为待清理项。

已记录的诊断 kind：`shell:start`（含构建内容标识）、`window:loaded`、`window:unresponsive/responsive/render-gone`（本轮未触发）、`bridge:window`、`bridge:event`、`bridge:ack-failed`、`bridge:exit`、`close:phase/stopped-research/forced`、`renderer:stream`、`renderer:longtask`、`renderer:input-delay`、`renderer:error`。

产物：`desktop/preview-artifacts/research-freeze/freeze-report.json`（修复后全部读数）与 `burst-cpu-profile.json`（修复后 CDP profile 原始数据）。修复前的同名产物被第二次运行覆盖，其关键数字（p95 689 / max 885、`querySelectorAll` 233 ms 等）完整保留在本节与第 3.3 节的表格里。该目录被 `desktop/.gitignore` 忽略，属本机验收产物，不入库。

---

## 7. 验证命令

```powershell
# 仓库根
.\.venv\Scripts\python.exe -m pytest tests/test_desktop_research_recruitment_timeout.py tests/test_desktop_team_runtime.py tests/test_desktop_team_bridge.py tests/test_desktop_research_stop_settle.py -q
.\.venv\Scripts\python.exe -m pytest tests/test_desktop_research_execution.py tests/test_desktop_diagnostics_home_row.py -q
.\.venv\Scripts\python.exe -m ruff check misaka tests   # 基线 791 错（见第 2 节）

# desktop
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright test e2e/execution-timeline.spec.ts e2e/desktop-research-team.spec.ts
pnpm exec playwright test --config playwright.electron.config.ts
```

---

## 8. 验收结果（逐项，含回归修正）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（0 error） |
| `pnpm lint`（oxlint，163 文件） | **0 warnings / 0 errors** |
| `pnpm build` | 通过；产物内容标识见第 4 节任务一（修复后 renderer chunk 变为 `index-9l1plo9l.js`） |
| `pnpm test`（vitest，69 文件） | 最终全量 **618 passed / 1 failed**；失败项 `executionTimeline.test.tsx > merges a long consecutive run of calls into one lane` 单独跑 **12 passed**，属本机负载假失败（基线时同类假失败是 `Sidebar.test.tsx`）。基线 561 项 → 现在 619 项，新增 58 项全部通过 |
| `pytest tests/test_desktop_research_execution.py tests/test_desktop_diagnostics_home_row.py -q` | **11 passed** |
| `pytest` 计划指定 4 文件子集 | 基线 39 passed / 2 负载假失败；两失败项单独重跑 1 passed + 1 passed（第 2 节） |
| `ruff check misaka tests` | **791**（= 基线，自身改动零新增；中途一度 796，已清） |
| `playwright test e2e/execution-timeline.spec.ts e2e/desktop-research-team.spec.ts` | **7 passed** (40.8s) |
| `playwright --config playwright.electron.config.ts electron-research-freeze.spec.ts` | **1 passed** (1.4m)，读数见第 6 节 |
| `… electron-close-fallback.spec.ts` | **6 passed** (3.7m)（末尾 1 条 worker teardown 超时为本机环境噪声，非用例失败） |
| `… electron-research-conversation.spec.ts` | **1 passed** (26.9s) |
| `… electron-workflows.spec.ts` | **1 passed** (48.6s) —— 该 spec 此前在本机长期红（powershell 超时 + 关闭契约），本轮更新到新契约后转绿 |
| `playwright --config playwright.electron.config.ts`（全量 12 项，生产构建） | **12 passed** (8.1m)，含 `electron-research-runtime.spec.ts` 三例；仅末尾 1 条 "worker teardown timeout" 环境噪声（不是用例失败） |

### 本轮发现并修正的两处自身回归（都有测试钉住）

1. **`before-quit` 对"空闲研究宿主"多问了一次原生模态**。第一版把所有 `before-quit` 都交给关闭流程询问，导致 `electron-research-conversation.spec.ts` 在 `app.close()` 处挂死（真实模态无人应答）。现在区分：确有研究在进行（`researchActive || researchStarting || researchWaiters.size > 0`）→ 走询问；只是宿主开着且空闲 → 协作释放后再完成退出。修正后该 spec 26.9 s 通过。
2. **`Timeline` 单帧化把"用户滚动时的锚点采集"也延后了一帧**，导致 `conversation.test.tsx` 的"段落锚点随扩张保持"用例失败（350 而非 470）：延后采集会把扩张后的位置当成阅读锚点。修正为滚动事件同步采集、只有消息/尺寸驱动的几何pass合并到帧。同时新增用例证明"一帧只读一次锚点"。

`electron-workflows.spec.ts` 的关闭段也按新契约更新：页面能应答时由应用内对话框选择 `最小化到托盘`（等价于原生框的 `后台继续`），取消后再按一次关闭走 `取消`；"页面卡死时的原生兜底"由 `electron-close-fallback.spec.ts` 专门覆盖。

---

## 9. 最终验收清单对照

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 原卡死根因有证据，最小复现测试通过 | **达成（机制层面）** | 第 3.3 与第 6 节：`querySelectorAll`/`getBoundingClientRect` + 每 token 全量快照无合并，复现阈值被越过后由同一 spec 转绿 |
| 六角色研究启动时能滚动、展开、输入、切换会话 | **达成** | `electron-research-freeze.spec.ts` 通过；交互探针 174/20/180/465 ms |
| 整个界面无响应时关闭按钮仍能触发原生处理 | **达成** | `electron-close-fallback.spec.ts` 6 passed（含忙循环下从主进程调用窗口关闭） |
| 强制退出只清理本应用进程树 | **代码 + 单测达成；端到端只覆盖协作停止** | `closeFlow.test.ts`（forceTerminate / 清理失败不谎报）；spec 走真实宿主协作停止后退出 |
| 子任务可查看真实命令、参数、输出、错误；运行中与历史均可 | **达成（正式卡片）** | `tests/test_desktop_research_execution.py` 11 passed + `ResearchTaskDrawer.test.tsx` 9 passed |
| 断流 / 字段校验失败 / 子进程启动失败各有明确状态 | **部分** | 校验失败与断流：spec 与 store 测试覆盖；子进程启动失败属本机环境问题（本轮基线未复现，见第 2、10 节） |
| 重试不重复提交课题、不重复创建角色或研究 | **未回归** | 未改动该逻辑；`researchEventIngest` 的 ack 同步路径与 seq 隔离有测试钉住 |
| 原有 `WinError 5` 单独复测并记录 | **达成** | 两个基线失败项单独重跑均通过；本轮 `WinError 5` 未出现（第 2 节） |
| 使用生产构建做真实 Electron 验证，保留报告 / trace / 截图 | **部分** | 生产构建 + 报告 + CDP profile 已保留；未截图（spec 以读数断言，不以像素断言） |

---

## 10. 剩余问题（保持未完成，不推测结案）

1. **`desktop_run_member` 辅助任务的实例入口未实施**。任务四要求"辅助任务从其工具结果中的真实 `agentId` 进入实例详情，服务端验证其属于当前团队"。当前实现只开放"正式研究卡片 → 任务抽屉 → 实例"这一入口；成员辅助任务需要解析团队文件以验证 `agentId` 归属，本轮未做，未标完成。
2. **无研究运行时的"应用内退出"在本机未在 60 s 内观察到 OS 进程终止**。状态机读数完整走到 `stopping → exited`，随后主进程执行上下文被销毁（`electronApplication.evaluate` 报 "Execution context was destroyed"），但 `app.process().exitCode` 在该窗口内仍为 null；带真实研究宿主的同一用例则在 90 s 内观察到退出。已把该用例改为断言可稳定复现的部分（状态机终态 + 开始拆除），进程级终止留作待复核项。
3. **故障现场没有诊断日志**。21:33–21:40 那一次无法给出当时的栈；本轮结论来自同一链路（Electron → preload → bridge → store → Timeline）上的受控复现与 profile，属于"机制被证实"，不是"那次现场的直接读数"。今后再有卡死，`~/.misaka/logs/desktop-diagnostics/` 与 `renderer:longtask` / `renderer:input-delay` / `window:unresponsive` 记录可直接对号。
4. **诊断字段语义粗糙处**：`bridge:window.dropped` 把"环形缓冲满 300 后裁剪旧项"也计入丢弃，与"未能送达渲染进程"混在一起；仅影响读数解释，不影响功能。
5. **`ruff` 基线 791 错未处理**（665 条 F401 集中于 vendored 的 `misaka/core/documents/pageindex/flash/**`，未进 `extend-exclude`）。本轮要求是自身改动零新增，已满足（修复前一度 796，已回到 791）。
6. **pytest 全量未跑**：按既有环境结论（约 125 项 `WinError 5`/symlink/spawn 噪声、65 分钟），本轮只跑计划指定的 4 文件子集与两个新增文件；全量留作后续。
7. **浏览器 e2e 全量未跑**：本轮跑计划指定的 `execution-timeline` 与 `desktop-research-team`；`modelPicker.spec.ts` 的 1 项长期红与本工作区已知环境问题依旧存在（见记忆）。

---

## 11. 实施日志

- 22:40 基线采集（第 2 节）。
- 22:45 复核"1 项 WinError 5"：两个失败项单独重跑均通过，属负载假失败；`WinError 5` 未复现。
- 22:50 完成故障会话与桥接链路只读取证，确认"每 token 全量快照 + 零合并"这一可测量过载条件。
- 23:05 首次真实 Electron 复现跑通到第 20 轮（断言口径写错，非产品失败）：paced 链路 p95 3 ms；注入突发 p95 689 ms / max 885 ms。
- 23:10 修正 spec（scoped 断言、CDP profile、锚点保留探针、诊断闭环断言）。
- 23:20 诊断层（主进程 + 渲染侧 + home 治理行）与关闭状态机落码，单测 42 passed。
- 23:30 事件预算队列 + Timeline 单帧几何 + 摘要脱敏窗口落码；`conversation.test.tsx` 因单帧化更新断言口径并新增"一帧一次锚点"回归。
- 23:45 执行记录读模型（Python）+ 抽屉接入 + 两侧测试通过（8 + 9）。
- 23:58 记录构建标识内容哈希；真实 Electron 关闭兜底 spec 运行中。
- 00:05 关闭兜底真实 Electron 首跑：4 passed，其余为忙循环注入方式与测试工具问题；改用"页面自行进入忙循环"的注入方式后 6 例全通过。
- 00:40 发现并修正自引入回归 1：`before-quit` 对空闲研究宿主多问了一次原生模态 → `electron-research-conversation.spec.ts` 挂死；改为"有研究在进行才问，空闲宿主直接协作释放"。
- 00:55 发现并修正自引入回归 2：Timeline 把滚动时的锚点采集也延后一帧 → 段落锚点用例失败；改为滚动同步采集、仅消息/尺寸驱动几何合并到帧。
- 01:10 `electron-workflows.spec.ts` 关闭段更新到新契约（应用内 `最小化到托盘` / `取消`），本机首次转绿 (48.6s)。
- 01:20 修复前后对照读数写入第 6 节：注入负载提高到 5.09 MB/轮（3.6 倍），p95 从 689 ms 降到 23 ms；`querySelectorAll` 从 profile 前十消失。
- 01:45 全量 vitest：617 passed / 2 failed（均单独通过），给抽屉用例补 10 s 负载容错。
- 02:05 全量 Electron（生产构建，12 项）：**12 passed** (8.1m)。
- 02:30 全量 vitest 复跑：**618 passed / 1 failed**，失败项单独 12 passed，属本机负载假失败；ruff 回到 791 基线（零新增）。
- 02:35 记录：本轮不提交、不推送；真实研究数据（`~/.misaka`、`.misaka`）只读，未清理，未重发任何真实研究。
