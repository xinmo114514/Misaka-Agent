# 桌面研究模式可靠性修复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划尚未实施，所有门槛必须凭当轮证据更新。

**Goal:** 修复审查中已确认的跨运行器、事务、请求释放、报告交付及页面状态缺陷，让用户从桌面走完研究、拿到真实最终报告、开启下一轮，并能停止与恢复。

**Architecture:** 保留原生研究算法、任务板、预算、driver lease 与文件任务契约；收拢桌面研究的 start/continue/message/stop 路由。分离业务终态、资源清理、报告交付与页面选择，前端通过统一状态投影展示真实进度。采取逐关口修复，不并行改写共享核心文件。

**Tech Stack:** Python 3.12+、SQLite、Electron、TypeScript、React、Zustand、Pytest、Vitest、Playwright；本次不引入新基础依赖。

**Spec:** C:/frontend-research/Misaka-Agent/docs/superpowers/reports/2026-10-11-desktop-research-audit.md；本计划“固定设计与不变量”是该审查的执行补充。

**Date:** 2026-10-13，Asia/Hong_Kong。

## 1. 固定设计与全局约束

- 全局单研究运行；新入口与旧后台研究分离。保留 TUI/CLI、原生 phase、动态招募、任务依赖、证据、审查、报告、预算与 lease 语义。
- 保留当前未提交源码改动及用户生成的 PROJECT.md、cards、nodes、final、research 等数据；不自动提交、推送、清理或重发真实课题。
- 默认停止新增功能及大范围视觉改造；本次只增加可靠性必需的状态、错误、任务计数及控制入口。
- 测试使用独立 MISAKA_HOME、APPDATA、研究板、workspace 与 Electron userData，真实用户目录只读。避免模拟业务成功绕过生产调用链。
- 招募截止仍为 600 秒；前端启动预算 650 秒。这两个现有修复保留，不再当作本次新交付。
- 消息咨询使用 consult=True，原生显式返工的默认 consult=False 保留。expected_generation 必须到达真实领取 CAS，而非仅在启动进程前检查。
- 文件仍拥有任务 generation 和静态 status；不把文件写失败吞掉，也不把旧卡文件重新导入为已经结束任务的新状态。
- accepted、applied、业务 completed、资源 settled、report delivered 是不同事实。仅按已验证事实更新状态，未知送达先核对原请求收据。
- done 是持久化业务终态；后续取消或辅助清理失败不降级为 stopped/partial。partial 产物始终明确标示不完整。
- 报告必须来自属于该 run 的已注册、摘要匹配的真实产物；真正持久化后才登记 delivered。占位内容不占用最终交付身份。
- 页面版本只由用户导航或有效导航意图改变；后台 hydration 不导航。后台数据回包、页面选择、编辑器清理分别校验归属。
- 进度展示真实阶段与任务计数，不输出伪百分比或未经校准的剩余时长。

### 证据基线

2026-10-11 的审查结果：前端全量 625 passed / 1 failed，失败为新增提示条的硬编码 amber 颜色；额外后端子集 32 passed。上述是历史基线，执行阶段重新运行，不作为当前版本已通过证明。

真实 r_93e9a6554b 的数据库锁错误已确认；当时具体持锁进程尚未定位。已隔离复现“事务内文件投影阻塞 → 另一连接约 5 秒 database is locked”。修复该已知机制与补齐真实锁诊断并行推进，但不把候选持锁方写成最终结论。

上一轮完成清单的全量、端到端及真实模型验收勾选缺少对应证据，应在任务 0 校正为历史声明，保留原始记录。

## 2. 最小接口与状态约定

### 后端

1. 在 DesktopExecutionScope 内提供私有卡片控制适配器。消费现有 team、policy、root session、run/card 归属；普通 TUI/CLI 不安装此适配器。
2. 续跑请求贯通 taskId、expectedGeneration、consult、requestId 和 owningRoot。worker_entry 与真实 claim_resume 使用同一捕获代次；代次或归属不匹配返回明确错误，不启另一张卡，不落回全局 panel。
3. 控制回执区分 accepted/settled，并返回真实 executionKind/executionId；保留 TUI 既有 pane 字段，桌面结果不伪造 pane。请求去重沿用稳定 requestId 与既有收据/任务事件机制。
4. executor 生命周期采用 open → closing → released；closing 停止新 admission，opening/active streams 均被管理。关闭结算失败保留可重试管理对象，返回 cleanup_pending。
5. 报告交付拆为“准备已验证正文”和“请求持久化并等待确认”。复用 AgentSession 的 _onPersist/_onError 和原 _deliveryId 去重；补交先检查保存的 root 与 workspace 归属。
6. 宿主快照增加可选 lifecycle 与 reportDelivery：启动 requestId、stage、startedAt、deadlineAt、可停止能力；交付 artifactId、state=pending/delivered/failed、固定错误码。旧快照缺字段时显示待同步，不推断成功。

### 前端

保持普通会话当前结构，研究新增小型编辑器记录及统一 selector：

```ts
type ResearchView =
  | { kind: 'new'; ownerKey: string; version: number }
  | { kind: 'conversation'; ownerKey: string; sessionId: string; version: number }

interface ResearchEditor {
  text: string
  revision: number
  attachments: Array<PreparedAttachment & {
    attachmentId: string
    preparationId: string
  }>
  model: ResearchModelRef | null
  thinkingLevel: string
}

interface ResearchUiProjection {
  viewKey: string
  title: string
  messages: ChatMessage[]
  turnBusy: boolean
  lifecycleLive: boolean
  canStop: boolean
  needsUserInput: boolean
  controlTarget:
    | { kind: 'startup'; requestId: string; workspace: string; sessionId?: string; streamId?: string }
    | { kind: 'run'; runId: string; workspace: string; rootSession: string; sessionId?: string; streamId?: string }
    | { kind: 'turn'; workspace: string; sessionId: string; streamId?: string }
    | null
}
```

- 新入口 ownerKey 为 new:normalizedWorkspace:entryId；entryId 在新建会话/明确创建新入口时生成，返回该入口复用同一 ID。对话 ownerKey 为 conversation:researchSessionId。owner 不依赖 view version。
- 研究编辑器按 ownerKey 保存；普通聊天不共用研究编辑器。切页只选择记录，不交换、覆盖或清空文字。
- bindResearchSnapshot 只合并所属后台数据；selectResearchView 才导航。启动、历史打开、澄清、重试和停止全部使用这两个边界。
- 新入口参数选择仅修改 editor 的本地配置，发送 0 条普通会话/旧团队设置命令。真正建立新宿主时才应用该配置。
- researchCards 作为归一化 run 元数据中心；researchRuns 保留列表发现与排序。列表、详情、通知、activity 共用 upsert 和 selector，避免另存一套相互覆盖的实时状态。

## 3. 顺序实施任务

每个任务的执行顺序固定：写失败用例 → 记录 red 输出 → 最小实现 → 记录 green 输出 → 独立复核 diff。任务 1–4 涉及共享后端文件，顺序实施；任务 5–6 依赖接口完成后实施。审查与测试可以并行，写入同一文件的实现不并行。

### Task 0 — 基线、隔离与证据记录

**文件：** 本计划；C:/frontend-research/Misaka-Agent/docs/superpowers/plans/2026-10-11-desktop-research-lifecycle.md；新证据目录 C:/frontend-research/Misaka-Agent/docs/superpowers/evidence/2026-10-13-desktop-research/。

- [ ] 保存 git status、HEAD、现有 diff 和未跟踪源码清单；将研究产物与源码分开列出，禁止自动清理。
- [ ] 实施环境包含经核对的当前工作树改动；不直接从裸 HEAD/远端默认分支开始并遗漏已有修复。
- [ ] 建立独立测试 home/workspace/userData；确认其绝对路径与真实用户目录不同。
- [ ] 重新运行前端全量、typecheck、后端研究与平台子集，按既有失败/新增失败/未执行分栏记录。
- [ ] 校正上一轮清单：声明、自动测试、真实 bridge、Electron 和真实模型分别登记；没有执行证据的项目保持未验收。

**验收：** 能准确说明修复前版本、失败项及测试数据边界；没有真实研究状态变化。

### Task 1 — 桌面卡片消息与续跑归属

**文件：**
- 新建 C:/frontend-research/Misaka-Agent/misaka/desktop_research/card_control.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/desktop_research/runtime.py、worker_entry.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/core/network/messages.py、dispatch.py，以及 C:/frontend-research/Misaka-Agent/misaka/core/research/node.py 的兼容参数传递。
- 新增 C:/frontend-research/Misaka-Agent/tests/test_desktop_research_card_control.py。

**接口：** scope-local wake_card hook 及卡片控制适配器；expectedGeneration/consult/owner 到实际 CAS；普通控制默认参数保持兼容。

- [ ] 先复现私有成员完成后收到消息 → 全局 CARD_SHELL → roster 错误。
- [ ] 安装 scope-local 消息续跑 hook，root 与 worker 的 MessagesPart 均使用该私有接口；校验目标 run、task、team 与 root。
- [ ] 在 worker 的实际领取路径携带 expected_generation 和 consult=True。显式返工仍使用 consult=False；咨询不重置已完成后代。
- [ ] 续跑进程及等待模型屏障的 pending launch 进入同一 owned registry，停止能找到它们；重复请求不多开进程。
- [ ] 保留普通 TUI/panel 的原始路由和回执格式；桌面研究归属丢失时返回错误，不用全局名单替代私有团队。
- [ ] 验证正常 worker、嵌套子 Agent、已完成卡咨询、模型切换排队及 stale generation 场景。

**必须断言：** 桌面咨询不调用 panel continuation；child 使用所属 model-policy；预检查发现代次过期时零进程启动，启动后的代次竞态零领取、零模型调用且 child 退出；咨询后代状态不变；错误根会话零副作用；原生 TUI 显式返工仍有效。

### Task 2 — 请求释放、关闭与取消结算

**文件：**
- 修改 C:/frontend-research/Misaka-Agent/misaka/desktop_research/runtime.py、model_policy.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/core/research/wiring/research.py 与 C:/frontend-research/Misaka-Agent/misaka/cli/desktop_bridge.py。
- 新增 C:/frontend-research/Misaka-Agent/tests/test_desktop_research_cleanup_contract.py；补充现有招募超时及模型策略测试。

**接口：** executor closing、可重试 release task、cancel_startup 的 settled 回执。

- [ ] 建立 active ticket 注销失败、opening stream 期间 close、end_request 首次失败后重试、二次取消的失败测试。
- [ ] 关闭前先停止该 executor 新 admission，取消/等待其 opening、active stream、缓存预热及 idle job；并发 close 共用一个结算 task。
- [ ] end_request 成功后才标记 ticket released；unregister_executor 成功后才删除 session/callback 管理引用。
- [ ] 首次结算最长等待 30 秒；超时返回 cleanup_pending，保留对象及因果信息，不把已经成功的业务结果改成 worker crash。重复关闭继续结算。
- [ ] cancel_startup 对全部 owned startup/pending launch 执行 cancel + gather/settle；项目准备返回、run 创建前、driver/worker 启动前核对取消意图。
- [ ] 控制 ACK 区分“停止已接收”与“停止已结算”；停止过程中不重复控制，也不自动开始下一轮。
- [ ] 用 live PID + birth identity 恢复死进程 ticket，不删除仍活跃或权限未知的 executor。

**必须断言：** settled 后零 owned pending launch、零活跃 ticket、零 residual executor/callback；失败后仍能重试释放；取消确认后无新 run/worker；done 状态不因清理变成失败。

### Task 3 — 写事务与文件发布的兼容修复

**文件：**
- 修改 C:/frontend-research/Misaka-Agent/misaka/core/platform/tasks.py、cards.py。
- 新建 C:/frontend-research/Misaka-Agent/misaka/core/platform/card_publication.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/core/research/workflow.py、publication.py、runs.py 中持锁的文件准备路径。
- 新增 C:/frontend-research/Misaka-Agent/tests/test_research_board_contention.py、test_card_projection_recovery.py。

**设计锁定：**
1. 卡文件锁在 SQLite 连接锁和写事务之外取得；多卡按 taskId 排序。卡锁等待上限 2 秒，失败不先取得 DB 写锁。
2. 字节读取、摘要计算、完整卡文件序列化、临时文件写入在 DB 写事务外完成。
3. 写事务只保留 generation/claim/driver CAS 与短 SQL、已准备文件的原子替换；禁止等待文件锁、模型、网络或长文件扫描。
4. file 与 SQLite 的 crash window 通过持久化 publication intent 闭合。既有 research publication helper并非直接外置 I/O 的现成实现，需要调整其 prepare/commit/recover 边界。
5. intent 记录 taskId、expectedGeneration、claimFence、旧/新状态、旧/新文件摘要、旧字节备份路径、新暂存文件路径和 operationId。保留恢复材料直至确定提交结果；文件发布失败仍导致状态转换失败。
6. 用现有 events 表登记 card_projection_committed 及 payload.operationId，标记与任务 CAS 在同一 SQL 事务中提交。恢复按标记判断：已提交保留新版，未提交恢复旧备份；先校验 generation/claim fence，文件摘要既非旧版也非新版则报告外部修改冲突，不覆盖。恢复完成后清除材料并解除 pending 门禁。

- [ ] 先用真实跨进程 FileLock 重现锁等待；记录持锁方、pid/thread、connection/transaction ID、SQL 指纹与持锁时间，不记录 SQL 敏感参数。
- [ ] 实现前置卡锁与预写准备，覆盖 mark_stopped、promote、claim_resume、reopen、完成状态投影；枚举所有 _mirror_status 调用及外层 owned_txn/write_txn，确保嵌套调用也先准备文件再进入 SQL 临界区。
- [ ] 实现 publication intent 与 pending 门禁：恢复前，reconcile 不把旧 at-rest status 导回新 DB 状态；部分发布不启动依赖任务。
- [ ] 将报告注册/证据摘要准备与批量文件扫描从 writer 临界区移出；进入 SQL/CAS 前重新验证 owner/generation。
- [ ] SQLite BUSY/LOCKED 仅重试已回滚的 SQL/CAS 单元，累计截止 20 秒，退避 50/100/200/400 毫秒、上限 400 毫秒；非锁错误不重试。
- [ ] 不通过重跑整轮 workflow、文件发布、进程启动或交付弥补 SQL 错误。预算耗尽时保留可恢复故障与 checkpoint，按所属资源结算。
- [ ] 对准备后/替换前/替换后提交前/提交后回执前逐点注入中断，验证恢复协议。

**必须断言：** 等待卡锁时其他连接仍可写；文件写失败不产生假 done；reconcile 不把 done/stopped 恢复 ready；短锁释放后同操作完成一次；超时可恢复且不多建卡；generation 改变时旧 intent 不覆盖新卡。

### Task 4 — 最终报告真实性、持久化与补交

**文件：**
- 新建 C:/frontend-research/Misaka-Agent/misaka/core/research/delivery.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/core/research/wiring/research.py、workflow.py。
- 修改 C:/frontend-research/Misaka-Agent/misaka/cli/desktop_bridge.py 的宿主快照/重连恢复。
- 新增 C:/frontend-research/Misaka-Agent/tests/test_research_final_delivery_contract.py；补充现有 done 恢复与 root lifecycle 测试。

**接口：** prepare_final_delivery 生成已验证正文；persist_final_delivery 通过 _onPersist/_onError 确认；delivery snapshot 与业务状态分离。

- [ ] 先建立缺文件、摘要不匹配、传入 content 与产物不同、跨 run artifact、异 root 补交及持久化失败测试。
- [ ] done 分支之前检查归属；done 补交只进入保存的 root。非终态原生显式 --here 采用窗口行为保持原样，done 不借 --here 改写归属。
- [ ] 无论调用方是否提供 final_data.content，均读取并校验 run.final_artifact、artifact.run_id、路径边界及摘要；以真实产物正文为准。
- [ ] 读取失败仅发结构化错误，保持 reportDelivery=failed，不追加最终报告，不占最终交付 ID。
- [ ] 复用 research-final:runId:artifactId 的既有稳定交付身份约定及 AgentSession 持久化回调；消息落盘后才登记 delivered。
- [ ] 若消息已落盘但回执丢失，扫描持久化消息重建收据，重连不重复追加。
- [ ] 兼容已有占位消息污染：只对确认正文缺失/不匹配的旧交付使用 research-final-repair:runId:artifactId:sha256，重试沿用同一 ID，补真正文一次；保留原记录并标记已被修正版取代，不放宽通用去重。
- [ ] index/bundle/views/资源关闭分别记录失败；报告业务结果不被这些异常遮蔽。done 后取消只结算资源，不产生 partial/stopped 覆盖。
- [ ] partial 同样确认真实产物，但始终保留 incomplete 身份。

**必须断言：** 正确 root 收到真实正文一次；产物错误零 delivered；persist 第一次失败后可成功补交；修复占位后真正文可见且只一条；done 清理故障后正文可恢复、业务终态保持 done。

### Task 5 — 页面、编辑器与异步归属

**文件：**
- 新建 C:/frontend-research/Misaka-Agent/desktop/src/lib/researchView.ts 与研究编辑器 slice。
- 修改 C:/frontend-research/Misaka-Agent/desktop/src/store/useSessionStore.ts、useSettingsStore.ts。
- 修改 Composer、ModelPicker/Depth、App、Timeline、sessionViewState，以及 ResearchHistoryDialog、ResearchRunPill 的调用点。
- 扩展 C:/frontend-research/Misaka-Agent/desktop/src/store/__tests__/researchPageView.test.ts 与 Composer/History/Pill 测试。

**三个 fence：**
- 数据：requestId → workspace/sessionId/streamId，结果更新原 run/receipt。
- 页面：version + target owner + operationId，过期回调只更新数据，不导航。
- 编辑器：ownerKey + revision + attachmentId/preparationId，成功只清理未被后续编辑的原 bucket。

- [ ] 同步 gate 全部放在设置 busy/ref 之前；真正发起后 finally 只释放自身 requestId 的 transient busy，durable 未确认启动不被误清。
- [ ] 切页只选择 editor。保留两边非空草稿、附件与参数；移除现有“切回对话就清空 draft”的测试预期。
- [ ] picker 开始前捕获 owner；preparation 以 attachmentId+preparationId 核对，路径仅用于去重；移除后同路径新附件不接收旧结果。
- [ ] bind/hydration 只更新后台；导航由独立 action 完成。覆盖 Composer、history、retryResearchMessage、requestResearchStop、Pill 澄清全部入口。
- [ ] 历史打开额外捕获 dialog generation；关闭、重开、卸载使旧请求的成功、失败及 finally 均失效，不关闭新弹窗或覆盖新请求状态。
- [ ] 停止 action 接收调用时捕获的 controlTarget，不从后来变化的 researchBinding 猜目标。新入口/历史查看中的后台停止按钮明确标示后台课题；startup、run、普通宿主 turn 分别走对应控制通道。
- [ ] 新入口配置选择无设置 IPC；已绑定对话的模型切换仍通过团队 barrier，运行中思考深度固定。
- [ ] App 的旧团队同步与普通 capability 回包不覆盖新 editor 配置；所有模型 UI 读取当前 editor/宿主的统一 selector。
- [ ] 新入口 messages=[]、独立 viewKey；不回退普通或旧研究历史。turnBusy 与 lifecycleLive 分开，active+native idle 仍保留停止。
- [ ] 普通会话 loading/error 不误阻挡独立研究入口；全局单 run gate 由 Task 6 的 activity 决定，不只看当前 binding。

**必须断言：** 被挡后返回旧研究立即可发；A→B→A 回包乱序不抢页；历史打开中关闭再重开，旧回包不干扰新弹窗；两侧文字附件完整；同路径旧 preparation 无效；新入口换模型零旧团队/普通设置 IPC；阅读终态历史时，后台 active/native idle 的停止准确命中后台 run；旧 root 后台结果正常入账；打开新会话是真空白。

### Task 6 — 单一真实状态源与最小进度区

**文件：**
- 新建 C:/frontend-research/Misaka-Agent/desktop/src/lib/researchActivity.ts。
- 修改研究 metadata upsert、App、ResearchHistoryDialog、ResearchRunPill、ResearchTaskDrawer、Composer，以及 C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchGraph/ResearchGraphCanvas.tsx 的既有列表标签。
- 修改 C:/frontend-research/Misaka-Agent/desktop/src/types/research.ts。
- 补充 C:/frontend-research/Misaka-Agent/desktop/src/test/colorConsumers.test.ts 覆盖，但保留原守卫强度。

- [ ] board-wide activity 每 4 秒单飞读取；history 打开时订阅列表刷新，关闭取消该需求；各 run 的详情请求合并，避免多个组件各自轮询。
- [ ] active 列表中消失的已知 live run，补 details 确认终态；同步失败保留最后数据并显示同步错误/最后成功时间，不推断完成。
- [ ] 列表、详情、live notice 同一 upsert；每 run 的请求 epoch/stream seq 防旧响应回退终态，显式 resume 建立新控制 epoch 允许恢复。
- [ ] 展示优先级：业务终态 status → stopping → waiting_input → 活动 phase/stage。failed+active 显示失败和 lastError，不再显示执行中。
- [ ] 持续区显示当前阶段、完成/总任务、运行与失败数量、运行时长、最近有意义活动、停止/返回/查看详情。
- [ ] 只有 waiting_input 且存在待回答问题才显示“等待你的回答”；正常 driver 运行显示“正在研究，暂无需回复”，可选补充入口另标示。
- [ ] 总任务量随实际研究变化；不把 5/8 换算成总研究百分比，不给未校准 ETA。超过 5 分钟无新活动显示“较长时间无更新，可查看详情”，不直接判失败。
- [ ] 启动 stage/pending 也进入全局 close/activity；主进程退出兜底继续保留。
- [ ] 固定 amber 类替换为 border-warning-border/bg-warning-surface/text-warning 等既有主题 role；修复任务详情 li 嵌套 li。

**必须断言：** 打开历史期间 active→failed/done/stopped 自动收敛；延迟 active 回包不覆盖 failed；resume 可以恢复同一 run；同步失败可见；native idle 后停止入口仍在；所有主题守卫通过、无嵌套列表警告。

### Task 7 — 分层全链验收与发布门槛

**文件：**
- 新建 C:/frontend-research/Misaka-Agent/tests/test_desktop_research_service_bridge_contract.py。
- 新建 C:/frontend-research/Misaka-Agent/desktop/e2e/electron-research-lifecycle.spec.ts。
- 新建 C:/frontend-research/Misaka-Agent/desktop/playwright.research-real.config.ts 与只由显式命令运行的真实模型验收 spec。
- 证据保存到本计划指定 evidence 目录。

- [ ] 契约测试实际调用生产前端研究服务和真实 Python bridge；模拟仅位于模型/provider 与外部材料边界，bridge/claim/receipt/persistence 均执行生产实现。
- [ ] Electron 固定数据用例走真实窗口、IPC、私有 worker、SQLite、消息咨询、报告持久化、历史重开与下一轮。
- [ ] 故障注入覆盖数据库锁、provider 阻塞、准备期间取消、done 后清理失败、断链、投递失败和旧前端回包。
- [ ] 跑前端全量、typecheck、build、后端研究/平台子集与原生 TUI/CLI 回归；再跑完整后端测试，既有基线失败单独登记，新增回归必须清零。
- [ ] 真实模型验收从独立桌面窗口进行：一次小研究完整报告 → 第二次新研究完整报告 → 另一次停止/重新打开/恢复。模型不替身，阶段不直接用内部函数推进。
- [ ] 固定小课题为“比较所提供的两份本地研究材料的共同事实、分歧与证据局限”；使用明确标记为测试语料的短材料。研究限制 max_depth=0、max_nodes=1、parallel=1、sister_parallel=2、max_followups=1、max_revisions=1，保留原生审查与最终报告阶段。
- [ ] 每轮真实模型上限 100,000 tokens、60 分钟；达到任一上限执行正常停止、保留证据并记未通过，不自动重跑。后续扩展到 depth=1/max_nodes=3 分支路径做单独 smoke，不以小闭环替代分支覆盖。
- [ ] 记录 run/session/task/generation/request/delivery ID、阶段截图、报告摘要、停止结算与资源计数；日志不含凭据或完整敏感提示。
- [ ] 修复任一失败后，重跑该故障回归及两轮正常闭环，检查下一研究不是复用旧 root/run。

**发布判定：** 自动回归没有新增失败；没有错运行器/孤儿进程/残留请求；报告是真实且幂等交付；新入口与旧任务隔离；真实两轮报告和停止恢复都有独立证据。任何一项缺证据，结论只写“部分修复/待验收”。

## 4. 验证命令与证据模板

前端工作目录：C:/frontend-research/Misaka-Agent/desktop。

```powershell
pnpm exec vitest run --maxWorkers=2
pnpm run typecheck
pnpm run build
pnpm exec playwright test --config playwright.electron.config.ts
```

后端工作目录：C:/frontend-research/Misaka-Agent。新增用例先按任务独立执行，整合后：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_desktop_research_card_control.py tests/test_desktop_research_cleanup_contract.py tests/test_research_board_contention.py tests/test_card_projection_recovery.py tests/test_research_final_delivery_contract.py tests/test_desktop_research_service_bridge_contract.py -q
.\.venv\Scripts\python.exe -m pytest -q
```

新增真实模型 spec 不加入默认自动用例；单独配置、显式执行，并按已选资源上限运行。

每个门槛记录：代码基线、执行环境、实际命令、退出码、通过/失败/未执行数、故障注入点、原始输出路径、结果解释及剩余问题。只有验收执行后才把对应复选框改为已完成。

## 5. 最终交付与范围排除

交付：分阶段代码、失败→通过的回归、跨层/Electron 用例、真实闭环证据、用户可见的持续状态区及修复后的验收记录。没有自动提交/推送。

本次不交付：多研究并行、算法重写、动态思考等级扩展、大规模图谱重做、精确剩余时间预测、用户旧研究自动恢复。旧故障研究的恢复始终需明确用户操作，先确认报告与 checkpoint 归属。

---

## 执行进度（2026-10-13 晚，实际证据）

**已完成并有红→绿证据：**

- Task 0：基线记录完成；证据在 docs/superpowers/evidence/2026-10-13-desktop-research/。
- Task 1：桌面卡片消息与续跑归属 —— 5 项专项测试全绿；messages scope hook、
  card_control.py、worker_entry/dispatch 的 consult+generation 贯通到真实 claim_resume CAS。
- Task 2：请求释放/关闭/取消结算 —— 5 项专项测试全绿；begin_closing/settle_executor、
  retry_end_request、release_session 的 cleanup_pending、cancel_startup 的 gather 结算。
- Task 3：数据库锁链修复 —— 跨进程持锁红证据（修复前 6.06s，基线 worktree）→ 修复后 <2s；
  card_publication.py 分阶段投影 + journal 恢复；58 项关联测试全绿。
- Task 4：报告真实性 —— 修复前基线 5 项全红 → 修复后全绿；prepare_final_delivery 三元组、
  done 归属检查、失败不占交付 ID。
- Task 6 核心：状态优先级（researchRunLabel）、历史自动刷新、li 嵌套、amber 换主题 role。
  前端全量 70 files / 630 tests 全绿；typecheck 0 错。

**仍未完成（保持未验收）：**

- Task 5 完整版：ownerKey 编辑器分桶（草稿/附件/模型按归属保存）、dialog generation fence、
  controlTarget 停止目标显式化。本轮只修了 busy 卡死与显示问题。
- Task 6 完整版：持续进度区（阶段、任务计数、运行时长、最近活动）与 activity 单飞轮询。
- Task 7：跨层契约测试、Electron 端到端、故障注入、真实模型两轮闭环 —— 全部未执行。

**发布判定：当前为部分修复。** Task 1–4 有证据可验收；Task 5/6 部分完成；
Task 7 未执行，不能标记研究模式可用。

## 续轮核对与更正（2026-10-13，优先于上面的历史完成声明）

- 上面的 Task 1–4 完成声明属于上一轮记录，不代表完整验收。独立复核发现回滚后错误发布、同卡 intent 覆盖、提交后发布失败假成功、请求释放提前标记、真实启动取消漏找、咨询消息丢失、done 被取消降级及报告缺持久化收据等问题，正在逐项补充真实失败→通过证据。
- Task 3 已改为有界前置卡锁、事务内原子替换/同事务提交标记、回滚恢复备份、同卡投影合并；所有路径的完整序列化/扫描移出 SQL 临界区尚未核对完成，保持未验收。
- Task 5 正在完成 owner 编辑器、附件 preparation 身份、显式导航、历史 dialog generation 与显式停止归属。全量中间失败均保留在 task5 证据，不以旧契约为借口忽略。
- Task 6 新增共享 activity coordinator 与纯 progress 投影；本轮运行 `pnpm exec vitest run src/lib/researchProgress.test.ts src/lib/researchActivity.test.ts`：2 files / 12 passed。证据 `task6-progress-green.txt`；组件与统一状态同步整合仍进行中。这不是桌面全流程通过证明。
- Task 7 新增真实前端 service→Python JSONL bridge→本地 HTTP provider 契约测试。首轮真实执行已保存 `task7-contract-first.txt`，因 fixture 后续规划缺 end_turn 脚本失败；按真实协议补齐后重跑。命令、根会话、run 与收据均走生产链，不模拟命令成功。
- 当前发布结论仍为 **部分修复／待跨层与真实模型验收**。真实两轮报告及停止/重开/恢复暂无本轮通过证据。所有用户原有研究与工作区改动保留，无提交、推送或自动恢复。

### 2026-10-14 接续核对

- 前端 service 真 bridge 契约扩大到模型屏障失败与重试：`task7-contract-barrier-verified.txt`，1 passed / 31.23s；模型 ACK 返回 failed 时，服务现在在登记/发送研究补充前退出，保留原模型与重试入口。该数仍是契约用例数，不是全流程数。
- Task 6 首次整合全量：`task6/full-regression-first.txt`，79 files / 681 passed；随后独立复核继续补背景停止确认/晚错 fence、图谱共享轮询与归属，需以收尾后的完整重跑为最终结果。typecheck/build 已有通过输出，构建大小提示未当作功能通过证明。
- Electron 局部真实窗口验收：`task7-electron/fixture-fourth-20261014.txt`，1 passed / 1.3m。真实 UI 输入→招募→等待输入→停止并结算→退出/重开→选择原项目→历史打开相同 run/root；三阶段截图及身份记录已保存。此用例尚无 worker 执行或最终报告，不替代两轮完成验收。
- 后端自动报告补交、dead pending owner 恢复、活动元数据组合：`backend-completion/reconnect-owner-activity-green.txt`，28 passed / 16.11s。测试最初的属性赋值错误已修正，并另保存真正 helper 缺失的 red 证据。额外事务准备与原生兼容回归继续执行；先前宽组合的 38 项失败正在逐项复核，未全部分类前不作发布通过结论。
- 独立复核新增跨层修复：partial 报告有真实正文也不等于 done；前端依据 incomplete 与业务 status 明确显示阶段性报告，后端消息补 status/result。零任务的等待/失败/停止/完成页移除误导性的“规划中”旋转占位。
- 显式真实模型脚本已启动一轮隔离调用。当前脚本主要直接走窗口公开 IPC，尚缺完整 UI 入口和所有验收证据，先作为真实运行时 smoke；不自动重跑收费研究、不标桌面全流程通过。每轮上限应覆盖招募开始至停止结算，而非仅 run 创建后的等待。

### 2026-10-14 后续实际验收（以本节为最新状态）

- 固定模型真实桌面两轮完成：`task7-electron/complete-eleventh-20261014.txt`，**1 passed / 3.5m**。所有命令、worker、领取、数据库、审查、报告产物与 JSONL 为生产实现，只有 HTTP 模型回复为固定 provider；从 Composer 输入到报告、再新聊天切研究模式启动第二轮，无内部函数推进状态。报告正文与登记产物一致，两个不同 run/root 各追加一条最终报告。身份及摘要在 `complete-result.json`。
- 固定模型桌面停止/重开/恢复：`task7-electron/stop-reopen-resume-20261014.txt`，**1 passed / 58.4s**。恢复后同一 run/root 回到实际 waiting_input；不是重新创建研究。
- 原来的固定脚本失败分别涉及 role 名、路径提取、原生 review 二次确认、正式 report 工具及相对产物路径，均保留输出，不当作生产修复红证据。后续主进程关闭缺陷另有真实 orphan PID/管道及两项单测 red 证据；现在直接启动 executable、用 close/stdio 验证退出，避免把 shell/launcher 的 exit 当成全宿主结算。51 项关联通过，最新 typecheck/build 通过。
- 后端相关最终组合：`backend-completion/root-final-stale-verified.txt`，**103 passed / 41.41s**。审查发现的 dependency 外层事务、无关卡锁、同事务第二次 replace 失败、宿主恢复错误 ACK、stale prepared generation 在替换前校验均已补修。
- 前端后台缓存/notice revision/retired stream 修补后全量：81 files / 698 passed（`task6/root-full-low-memory.txt`）。后续主进程两项新回归及最终全量另行记录，不把较早结果当成最新全量。
- **Task 3 仍未完整完成**：未声明投影的任意外层 writer 保留零等待兼容路径；`runs.write_text`、research `publication.prepare/recover`、`settle_done_tasks` 的报告准备/长文件扫描仍需进一步外置 SQL。已知功能回归修复与这个完整临界区门槛分开登记。
- **真实模型门槛仍未完成**：当前 deepseek/deepseek-v4-pro 返回 HTTP 402 余额错误，未创建真实研究；无自动重跑。正式 UI 固定 limits 参数入口未挂载的预检缺口也保持未验收。没有换模型、付费或改用户配置来绕过这些门槛。

发布结论：**部分修复；固定数据桌面正常闭环与停止恢复已通过，真实模型与完整 Task 3 门槛仍未通过。** 未提交/推送/删除用户研究或自动恢复旧研究。

收尾全量：后续主进程退出修补已纳入 `task6/root-release-regression.txt`，**82 files / 700 passed**；typecheck/build 通过。后端相关组合仍为 **103 passed**，不等同于整个后端全量通过。完整分层结果与未通过门槛见 `docs/superpowers/evidence/2026-10-13-desktop-research/execution-status-2026-10-14.md`。
