# 桌面研究模式全流程可靠性重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构桌面研究模式生命周期契约与页面隔离，解决启动卡死无超时、命令跨层拦截、新会话误入旧研究以及报告交付中断问题，实现全流程可靠运行。

**Architecture:**
1. 网关层契约收拢：分离普通会话与研究会话修改命令，修复继续研究时的模型/思考命令拦截，明确新建研究拒绝接管活跃研究；
2. 启动与取消管理：统一招募、项目准备、任务创建和 driver 启动的生命周期；将模型调用直接纳入超时边界，闭合创建前的取消盲区；
3. 页面与运行时解耦：前端会话状态区分新研究入口与后台活跃研究，独立草稿与事件监听，提供安全停止与返回指引；
4. 报告交付幂等化：以 (runId, finalArtifactId) 为凭据分离完成状态与界面投递，支持重连与失败补偿。

**Tech Stack:** Python 3.12+, Electron / TypeScript, React 19, Zustand, SQLite, Vitest, Pytest, Playwright.

## 实施阶段任务清单

### 阶段一：建立真实跨层基线，修正命令契约
- [x] **Task 1.1: 编写真实跨层契约失败测试**（已覆盖模型设置被阻断及新建研究误接管活跃研究）
- [x] **Task 1.2: 修正前端继续研究与模型切换命令**（移除提交研究前的普通 set_model/set_thinking，继续运行时改用 desktop_set_team_model 专用接口）
- [x] **Task 1.3: 修正新建研究的活跃检测与根会话接管逻辑**（明确新建时若存在活跃研究则拒绝静默合并并提示用户，不隐式绑定旧 root session）
- [x] **Task 1.4: 验证阶段一测试全绿**（startComposerResearch 45 项测试全绿）

### 阶段二：统一启动、超时与取消生命周期
- [x] **Task 2.1: 编写招募调用真实超时与启动取消盲区测试**（新增 test_recruitment_stream_call_that_never_completes_times_out）
- [x] **Task 2.2: 重构招募超时控制**（将 session.sendCustomMessage(triggerTurn=True) 纳入 wait_for 保护）
- [x] **Task 2.3: 统一启动任务登记与取消保护**（在 ResearchPart 中追踪 self._starts，init_project 返回后检查取消，abort 触发 cancel_startup 避免孤儿 run）
- [x] **Task 2.4: 调整前端超时预算并增强阶段进度通知**（前端启动超时由 180s 调整为 650s，覆盖 600s 后端招募上限并提供轮询保活）
- [x] **Task 2.5: 验证阶段二测试全绿**（招募与启动相关用例全绿）

### 阶段三：隔离研究页面与后台任务
- [x] **Task 3.1: 编写页面选择意图与后台绑定分离的单元与集成测试**（新增 researchPageView.test.ts 6 项测试）
- [x] **Task 3.2: 在 useSessionStore 中解耦页面展示与后台研究绑定**（新会话重置为 new 页面，保留后台 researchBinding）
- [x] **Task 3.3: 实现新研究入口的活跃研究提示与停止确认交互**（Composer 区分 new/conversation 视图，提示后台活跃任务，提供返回/安全停止入口）
- [x] **Task 3.4: 验证阶段三测试全绿**（useSessionStore、sessionViewState、Composer 36 项测试全绿）

### 阶段四：让最终报告交付可恢复
- [x] **Task 4.1: 编写报告交付幂等与失败补交测试**（新增 test_resuming_a_done_run_with_final_artifact_delivers_report）
- [x] **Task 4.2: 改进报告完成状态与交付记录分离**（抽取 deliver_final_report 并绑定 _deliveryId，支持已完成任务重连补交）
- [x] **Task 4.3: 容错处理清理与视图生成异常**（workflow 完成时隔离 _bundle 与 _views 异常，确保报告产物正常返回与通知）
- [x] **Task 4.4: 验证阶段四测试全绿**（报告与生命周期相关测试全绿）

### 阶段五：端到端与桌面完整流程验证
- [x] **Task 5.1: 运行全量单元测试与核心端到端用例**（后端 pytest 53 项通过，前端 vitest 139 项通过，typecheck 0 错误）
- [x] **Task 5.2: 记录各阶段证据并归档报告**

## 验证证据汇总
- Python 单元与集成测试：53 passed in 32.26s
- 前端 Vitest 测试集：7 passed, 139 passed in 19.39s
- 前端 TypeScript 编译：pnpm run typecheck (tsc --noEmit) 0 error
