# 研究工作区：对话内审批、专注/多窗双视图与手动恢复

日期：2026-10-18。分支 `codex/research-tiling-workspace`（既有未提交改动全部保留；本次未暂存、未提交、未推送）。未触碰任何真实研究数据：所有集成检查使用隔离 profile 目录与本地 fixture 模型。

## 实现

### 1. 对话内审批

审批从侧边独立面板改为对话内的结构化卡片（`ResearchApprovalCard.tsx`）：

- **同意 / 稍后 / 还需修改**：「稍后」只把卡片折叠成「已稍后，仍在等待你的审批」摘要，不发任何控制请求，因此不会暂停已批准的其他卡片。
- **版本校验**：卡片显示「版本 <tool_call_id 后 6 位>」，批准时携带 `expectedPlanId` 与该计划所属 `nodeId`。服务端围栏拒绝过期版本时，卡片显示「该计划已更新，请查看最新版本后再处理。」并提供「查看最新版本」，绝不静默重发。
- **分支汇总**走同一张卡片（「分支汇总待审批 · 第 N 轮」），澄清问题走 `resume_research` 的澄清字段。
- 数据来源复用共享的运行详情：活动轮询已经读取 `get_research_details`，卡片从中派生待审批材料，每个 Run 只读一次；只有在共享详情尚不存在时才补一次读取（并发挂载会合并为一次请求），不新增轮询。

### 2. 专注 / 多窗双视图

- 默认**专注**：左侧「智能体团队」列表 + 右侧当前成员会话；可「展开会话」占用整幅。多窗视图保留原有并排网格。
- 两种视图共享选择、阅读位置与折叠状态；切换按钮组为 `专注 / 多窗`，选择写入 `localStorage`（`misaka_research_view_mode`）并在重开后还原。
- 子代理会话只读，需要补充时提示「请在对话中向主控代理提出」。

### 3. 手动恢复研究

- **唯一入口**：`研究图谱` 旁的「恢复研究」，两个视图共用同一个运行头部，因此全应用只有一个恢复控件；横幅只叙述、指回该控件，各自渲染第二个按钮的情况已被测试固定为不允许。
- **状态规则**（`researchResumeAvailability`）：`done` 等终态不显示；`stopping` / `stopRequested`、等待澄清或审批、`driving === true`、驱动状态未知均**禁用**并给出中文原因；只有 `active` 且 `driving === false`、或 `stopped` / `failed` 且无有效驱动时**启用**。永不接管有效驱动。
- **ACK 不是成功**：点击后 `提交中` → 收到 ACK 后为 `正在确认恢复`，只有观测链路报告该 Run `driving === true` 才显示 `恢复成功`；30 秒未确认进入 `结果待确认`，只提供「刷新」，不自动重发。锁按 Run 保存在共享 store，切换布局或会话都不会发第二次请求。

### 4. 视觉层级与侧栏入口

- 运行概览、中断提示、停止记录、审批卡片重新分层；新增正文 ≥12px、次要文本 11px，保留粉紫柔和主题。
- 后台研究活动从底部横条移入侧栏（`ResearchBackgroundEntry.tsx`），保留代数围栏与「返回研究 / 查看详情 / 停止」动作。

### 5. 后端

`misaka/core/research/desktop_view.py` 的 `sessions_payload` 在运行摘要中新增三个字段，未新增端点、未新增轮询：

- `driving`：直接取 `runs.driver_is_live(run)`，与运行详情同源，列表与详情不可能给出相反结论；观察者复用该函数，因此驱动变化会进入 `research_sessions_changed`。
- `driverLock` / `driverExpires`：公布原始租约，便于解释状态。
- `awaitingApproval`：计划或分支汇总正在等待用户批准。**这一条是端到端验收自己暴露出来的**：计划审批期间运行保持 `active` 而驱动已正常结束本轮，租约因此空闲；没有这个字段，「无有效驱动」看起来与「中断」完全一样，恢复入口会对一个仍在正常运行的研究亮起。现在等待与中断被区分开，待审批一律禁用恢复。

## 验收

| 检查 | 结果 |
| --- | --- |
| 前端全量 Vitest | **106 文件 / 891 通过** |
| 类型检查 `tsc --noEmit` | **通过** |
| `oxlint` | **0 warning / 0 error**（234 文件） |
| 生产构建 | **通过**（dist CSS 148.92 kB，JS 1,550.13 kB；仍为既有的大 chunk 提示） |
| 后端相关回归 | **75 通过**（desktop_view / 会话观察者 driving / 卡片控制 / 计划审批） |
| Electron 端到端（分块工作区） | **1 通过，0 重试**（4.3 分钟） |
| Electron 端到端（停止→重开→恢复） | **1 通过**（1.2 分钟） |
| Electron 端到端（两轮完整研究） | **1 通过**（3.8 分钟） |

端到端场景 `e2e/electron-research-tiling.spec.ts` 实际验证：本地 fixture 模型发起研究 → 计划审批卡片点「同意」→ 5 张卡片因 429 配额逐卡停止且不伪造结论 → 关闭应用重开、进入历史同一 Run → 「恢复研究」可见且可用 → 再次批准 → 该 Run 恢复并跑到 `done`，`run.id` 与 `sessionId` 不变、无验收产出时的 `final_artifact` 为空、暂停记录清空。

`e2e/electron-research-lifecycle.spec.ts` 验证**整条研究主线**：

- **停止 → 重开 → 恢复**：发起研究到 `waiting_input` → 工作区「停止研究」→ `stopped` → 关闭应用重开、从历史打开同一 Run → 「恢复研究」可用 → 恢复到 `waiting_input`，`run.id` 与 `sessionId` 不变。
- **两轮完整研究**：第一轮跑到 `done`，校验 `reportDelivery.state === 'delivered'`、产物 `state === 'available'`、注册产物正文与 `research-final` 记录正文逐字一致（头之后不被打草稿替换）；再「新聊天」→ 研究模式 → 第二轮独立跑到 `done`。两轮产出 `run.id`、`sessionId`、会话根目录各不相同（`complete-result.json`：`firstRun r_577acabdae` / `secondRun r_be8fb46d20`，`reportSha256` 一致）。

## 验收过程中发现并修复的缺陷

以下都是先跑端到端才暴露的，纯单测不会发现：

1. **恢复入口对「等待审批」的研究亮起**。计划审批让运行保持 `active` 而租约正常释放，`driving === false` 与真相中断无法区分。修复：后端公布 `awaitingApproval`，恢复规则与中断横幅都据此视为「等待」而非「中断」。
2. **「同意」永远被判过期**。桥接层在 `approve_plan` 上用顶层 `nodeId` 定位计划，卡片只发了 `expectedPlanId`，于是服务端在空节点上查不到计划、每次都回「This plan changed since it was displayed」。修复：控制请求携带计划所属 `nodeId`，并在单测中固定该字段。
3. **两个恢复控件**。停止横幅原本自己渲染一个「恢复研究」，与头部入口重复，违反「只有一个入口、按 Run 加锁」。修复：横幅只叙述状态并指回头部控件，测试断言横幅内不存在恢复按钮。
4. **工作区里没有停止入口**。绑定研究的页面由 `ResearchTilingWorkspace` 取代整个时间线，于是对话 pill 里那个「停止研究」在进入工作区后根本不在屏幕上，只能从别的页面停止。修复：工作区头部新增「停止研究」（一次确认，仅 `active`/`waiting_input` 且未在停止时出现），并补 4 条单测。
5. **已停止的研究永远无法恢复**。`stop_requested` 只在恢复时清零，运行落到 `stopped` 后仍是 1，恢复规则据此一直判定「研究正在停止」。修复：先把「已结算」（`stopped`/`failed`）与「正在停止」区分开，结算态忽略该历史标志，并补回归单测。
6. **替换研究宿主被报成「连接断开」**。`stopResearchBridge` 是主动、预期的停止，但旧进程以 code 0 退出时 `close` 处理器仍会广播 `research_connection_error`，把紧接着启动的新一轮研究标成「研究连接已断开 (0)」。修复：主动停止前先清空 `researchHostIdentity`，使该退出不再当作连接丢失；并在 `bridgeExitContract.test.ts` 固定「先清身份、再等退出」的顺序。

历史上 `electron-research-lifecycle.spec.ts` 的第二轮本就通过过（`complete-eleventh-20261014.txt`），因此第 4–6 条确为本轮改动引入或被改动作掩盖的回归；另有一处测试自身缺陷：第二轮只按了回车、没有点向导弹窗的「确认并开始研究」，而 Composer 在向导打开时会丢弃再次发送，导致第二轮从未真正启动。

## 说明

- 本轮曾尝试回退，但该目录中 `desktop/src/components/ResearchWorkspace/` 整体为未跟踪文件，无法用 git 恢复会话前内容；经确认后继续完成实现与验收，未改动任何既有未提交文件。
- 后端全量测试中有若干既有 `PermissionError: [WinError 5]` 符号链接用例失败，位于 `test_research_deep_repairs.py` 等文件，与本改动无导入关系，属主机环境限制；相关研究回归选集全部通过。
