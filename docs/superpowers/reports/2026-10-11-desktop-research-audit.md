# 桌面研究模式可靠性深度审查 — 2026-10-11

## 结论与证据边界

当前桌面研究模式尚未达到全流程可用标准。问题同时涉及运行器归属、数据库并发、模型请求资源释放、最终报告真实性以及页面状态隔离，增加进度条本身不足以解决。

本轮只读真实研究板、消息库、会话和诊断日志，在临时目录或内存复现；不修改真实研究状态，不重发课题，不清理用户产物。代码审查针对当前含未提交改动的版本。此文是审查报告，不是修复完成记录。

真实样本：r_93e9a6554b，2026-10-11 15:19:24 创建，15:47:43 failed，错误 OperationalError: database is locked。8 张任务卡中 5 done、3 stopped，无最终报告。研究根节点仍为 executing。这些字段反映不同层次，不能把节点 phase 当作整个 run 当前状态。

## 一、阻断级问题

### 1. P1：消息续跑越出桌面私有运行时 — 真实日志证实

路径：
- C:/frontend-research/Misaka-Agent/misaka/core/network/messages.py:191–209、285–297、496–504
- C:/frontend-research/Misaka-Agent/misaka/ui/panel/daemon.py:185–191、1754–1790
- C:/frontend-research/Misaka-Agent/misaka/cli/card_shell.py:62–64

已完成卡收到 SendMessage 时，wake_card 转到全局 panel pane.continue_card，只有 task_id/say/generation/consult，没有桌面 team/model-policy/profile-root 归属。daemon 使用原生 CARD_SHELL，后者从全局 CFG profiles_root 找成员，而非桌面私有团队。

真实 t_a035e7 初代正常完成；随后第 2、3 代的消息续跑走 net continuation，分别产生 “Sister long-run-consequences is not in the roster.”。对应 headless 重试随后成功。纠正：不是首次招募或初代执行失败。

影响：协作消息可令已完成任务重新运行，却采用错误团队环境；并改变任务 generation，扩大重试与依赖等待。需要统一桌面研究拥有的 start/continue/message/stop 路径，不应靠把临时成员复制进全局名单补洞。

### 2. P1：文件投影阻塞时持有 SQLite 写事务 — 隔离复现

路径：
- C:/frontend-research/Misaka-Agent/misaka/core/platform/tasks.py:350–358、549–574、926–939、1396–1420
- C:/frontend-research/Misaka-Agent/misaka/core/platform/cards.py:213–223
- C:/frontend-research/Misaka-Agent/misaka/core/research/workflow.py:604–623、2693–2713

mark_stopped 等状态转换在写事务内调用 _mirror_status，后者取得卡片 FileLock 并读写文件。文件锁默认没有短超时。其他进程的 board connection busy timeout 为 5 秒。一般流程 SQL 错误按失败处理；lease heartbeat 的重试没有覆盖所有状态转换。

隔离探针使用实际 tasks.mark_stopped，模拟 cards.set_fields 阻塞，另一连接 tasks.add_event 在 5.08 秒报 OperationalError: database is locked；当时 writer_transaction_open=true，释放投影后原事务成功。

边界：复现证明这种锁链成立；真实 r_93e9a6554b 当时具体是哪一个进程/SQL 持锁，当前日志未给足证据，不将该候选机制认定为唯一根因。报告注册/引用提取也有事务内文件 I/O，应检查其锁持有时长。

### 3. P1：模型请求仍活跃时注销 executor，清理抛错 — 真实日志与内存复现

路径：
- C:/frontend-research/Misaka-Agent/misaka/desktop_research/runtime.py:584–592
- C:/frontend-research/Misaka-Agent/misaka/desktop_research/model_policy.py:146
- C:/frontend-research/Misaka-Agent/misaka/desktop_research/runtime.py 的 request release 回调

release_session 先移除 session/idle-job，再注销 executor；存在 ticket 时注销抛 ValueError: Executor still has active requests，且 session 已离开管理集合。真实 dev-err.log 与 task_runs 均记录该错误，t_a035e7 因而出现失败代次。

内存验证：ticket 活跃时 release_session 抛错且 sessions 已清空，随后 ticket 结束仍残留 executor/callback。另有释放回调先标记 released，再执行 end_request：若后者失败，再次 close 不再重试，ticket 可能永久残留。

影响：正常退出也可能被判成 worker crash，模型切换屏障与后续调度受影响。应先有界等待或取消请求并结算，再清理管理集合；释放成功前不写入“已释放”标记。

### 4. P1：报告读取失败被包装成权威最终报告 — 内存复现

路径：
- C:/frontend-research/Misaka-Agent/misaka/core/research/wiring/research.py:345–382
- C:/frontend-research/Misaka-Agent/misaka/core/agent_session.py:1492–1494

deliver_final_report 吞掉 artifact_text 的缺文件/摘要不一致异常，使用 finished 占位文字，仍加 “authoritative version” 标题与同一个 research-final:runId:artifactId 交付 ID。占位消息先持久化后，恢复产物的真正正文可能被该 ID 去重。

影响：报告正文没有交付，却出现权威成功标记，后续补交也失去机会。只有产物读取、校验与消息持久化均成功才应登记最终交付；失败使用明确错误，不占用最终交付 ID。

### 5. P1：done 报告补交早于原会话归属检查 — 控制流与内存复现

路径：
- C:/frontend-research/Misaka-Agent/misaka/core/research/wiring/research.py:597–605

done 分支调用 deliver_final_report 后返回，后面的 saved root_session 检查永不执行。内存探针从另一会话请求 done 补交，直接得到报告。专用研究 ingress 有自己的校验，但原生命令入口的新增分支绕过了这一不变量。

应先检查研究归属，再补交；不把“最终报告可恢复”做成任意会话接管。

## 二、前端确定回归

### 6. P1：阻挡新研究后永久 busy — jsdom 复现

C:/frontend-research/Misaka-Agent/desktop/src/components/Composer/Composer.tsx:335–341

先设置 researchStartingRef=true/busy，再在 new+active 分支 return，尚未建立 Promise，finally 不执行。第一次被正常阻挡后，返回当前研究再发送仍 startCalls=0/busy=true。检查应先于 busy 设置，或所有出口统一清理。

### 7. P1：页面版本只写不读，旧异步请求抢回页面 — 内存复现

- C:/frontend-research/Misaka-Agent/desktop/src/components/Composer/Composer.tsx:330–334、347–350、361–363
- C:/frontend-research/Misaka-Agent/desktop/src/store/useSessionStore.ts:555–556
- C:/frontend-research/Misaka-Agent/desktop/src/components/Timeline/ResearchHistoryDialog.tsx:43–48

researchPageVersion 全项目仅赋值。ownsContext 不比较页面意图/版本；bindResearchConversation 每次强制 conversation。等待发送结果时切 new 并编辑新课题，旧结果仍将页面拉回旧对话。历史打开异步也缺少关闭/导航 fence。

后台数据更新与页面选择应分别处理，明确打开或有效启动才导航。

### 8. P1：草稿只隔离一边，附件完全共用 — 内存复现

C:/frontend-research/Misaka-Agent/desktop/src/store/useSessionStore.ts:1192–1205、868–912

conversation→new 未保存补充草稿；返回时 draft 无条件清空。附件仍是一份全局数组，picker/preparation 回调没有页面 owner/版本。新研究附件可带入旧研究；同路径旧响应可覆盖新上下文附件。

现有 researchPageView “isolation” 测试断言补充草稿变空，事实上把丢失行为当成通过条件。回归测试必须两侧非空、附件异步切页、同路径响应乱序。

### 9. P1：新研究页的模型选择会修改后台旧团队 — 内存复现

- C:/frontend-research/Misaka-Agent/desktop/src/store/useSettingsStore.ts:703–707、775–784、855–857
- C:/frontend-research/Misaka-Agent/desktop/src/App.tsx:104–108
- C:/frontend-research/Misaka-Agent/desktop/src/components/Composer/ModelPickerDepthView.tsx:12

判断仅依赖 agentMode+researchBinding，忽略 new 页面。新入口选模型发 desktop_set_team_model(sessionId=OLD-ROOT)，思考等级仍被旧 binding 锁住；旧团队同步可覆盖新入口设置。应为新入口保存独立配置，在真正启动新宿主时应用。

### 10. P1：失败后历史仍写“执行中” — 状态分裂复现，匹配真实样本

- C:/frontend-research/Misaka-Agent/desktop/src/components/Timeline/ResearchHistoryDialog.tsx:25–29、128
- C:/frontend-research/Misaka-Agent/desktop/src/store/useSessionStore.ts:1173–1185、1442–1446

历史只打开时刷新一次，读取 researchRuns；详情/live notice 更新的是 researchCards，两者未收敛。即便 summary 已 failed，文字仍优先 run.phase；真实样本为 failed/active，因此映射为执行中。终态应优先 status，显示 last_error，已打开列表应自动更新，并标示同步失败。

### 11. P2：页面选择与停止入口仍有两套逻辑 — 静态确定

- C:/frontend-research/Misaka-Agent/desktop/src/App.tsx:443–450
- C:/frontend-research/Misaka-Agent/desktop/src/components/Timeline/Timeline.tsx:18
- C:/frontend-research/Misaka-Agent/desktop/src/lib/sessionViewState.ts:60–61
- C:/frontend-research/Misaka-Agent/desktop/src/components/Composer/Composer.tsx:111、689–693

new 页面回退普通历史；App 顶层仍依后台 binding 选择旧研究消息。native host idle 时研究 driver 仍 active，但主停止按钮仅依 isStreaming，可能消失。需要统一页面 selector 与独立 lifecycle busy/turn busy。

## 三、仍需闭合的后端风险

1. cancel_startup 仅 task.cancel，不 gather/settle；内存验证返回时任务尚未结束。“取消请求接收”与“取消完成”应分开。
2. workflow done 后清理 __aexit__/runner.close 抛错仍可覆盖正常返回，最终报告可能不交付；上一轮仅 try/except 包装辅助步骤没有覆盖整个出口。
3. partial 产物登记后派生视图失败仍可能阻断结果返回；异常处理不能制造另一个不可恢复出口。
4. run done 后等待视图期间 CancelledError 仍走通用 partial/stopped 路径，可能降级已完成状态。列为需要专门故障注入验证的风险，不声称已发生于真实样本。

## 四、测试与验收事实

本轮额外运行：
python -m pytest tests/test_research_root_lifecycle.py tests/test_research_resume_session_guard.py tests/test_desktop_research_stop_settle.py tests/test_research_board_tool_guard.py -q
结果：32 passed in 31.41s。

本轮前端全量执行：pnpm exec vitest run --maxWorkers=2。结果：70 个测试文件，69 passed、1 failed；626 个用例，625 passed、1 failed，耗时 315.18s，退出码 1。

失败项为 theme color consumer guard，定位 C:/frontend-research/Misaka-Agent/desktop/src/components/Composer/Composer.tsx:484：上一轮新增提示条使用 border-amber-500、bg-amber-500、text-amber-200，绕过现有主题 token，属于新增样式契约回归。另 ResearchTaskDrawer 测试输出 li 嵌套 li 的 React 警告；本轮不将通过的用例等同于无警告。

复现用的原始全量前端输出保留于 C:/Users/33669/AppData/Local/Temp/misaka-research-audit-vitest-20261011.log。

上一轮 53 个后端、139 个前端用例均为选定子集，不等于全量或完整真实模型验收。2026-10-11-desktop-research-lifecycle.md 将全量测试/核心端到端标为已完成，与当时展示的执行命令不符。本轮不依赖这些勾选做完成判断。

## 五、建议处理顺序

1. 先闭合桌面运行器归属：start/continue/message/stop 一律经所属团队 runtime。
2. 修数据库锁持有和模型请求结算，记录 SQL/事务/进程关联证据，再验证恢复。
3. 修报告真实性、归属、持久化交付和失败补偿。
4. 统一页面选择、草稿附件配置 owner、异步 fence 和终态状态源。
5. 最后补持续进度总览；用真实桌面入口完成报告、再完成下一次研究、验证停止恢复，作为发布门槛。

发布判定必须依赖上述全链验收；实际持锁进程在证据闭合前保持“待确认”，与已复现的锁机制明确区分。
