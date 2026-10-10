# 研究消息提交与恢复：实施及验证记录

日期：2026-10-10（Asia/Hong_Kong）。分支：`codex/research-submission-recovery`。

## 状态与证据边界

- 已实现并验证调查确认的输入分类、提交状态、回执、重试与取消缺陷。
- 原始现场“Enter prose in this research conversation.”仍缺同一 requestId 的请求及 ack，现场因果链尚未闭环。当前自然语言输入回归和真实 Electron/Python 本地协议夹具通过；这不是实际 DeepSeek 服务已验证的声明。
- 保留正文字符串及现有首尾去空白行为，段落、编号、Markdown、中文内部内容保持完整。提供商适配器与依赖版本保留。
- 实施前基线保存于 `C:/Users/33669/AppData/Local/Temp/misaka-research-baseline-27w_iuht`。比较基线中非本次负责文件，变更集合为空。所有原有未提交工作保留；未提交 Git Commit，未修改真实用户数据库。

## 已实施

### 输入与诊断

- `C:/frontend-research/Misaka-Agent/misaka/core/research/ingress.py`：控制器与 ingress 共用输入校验；分别报告错误类型、空正文、控制命令需求与会话身份；研究控制解析仅接受真正的 stop/resume。
- `C:/frontend-research/Misaka-Agent/misaka/desktop_research/runtime.py`：招募原文只记录一次；失败后的内部招募继续与用户意图区分，角色准备完成后再进入研究。
- `C:/frontend-research/Misaka-Agent/misaka/core/research/submissions.py`：日志只含请求/会话/流标识、文本类型和长度、空白/斜杠标志、版本、模型引用、异常类别和代码位置。排除正文、附件、认证头、密钥、第三方异常正文。
- `C:/frontend-research/Misaka-Agent/desktop/src/lib/researchDiagnostics.ts`：100 条上限的纯元数据环形缓冲。

### 回执与原始请求

- 在现有会话 JSONL 中追加 `type=custom, customType=research-delivery`，无新增数据库或迁移。该记录既不进入模型消息，也不作为用户对话内容显示。
- 首次 prepared 回执在原生输入前落盘；持久化失败发生于 transient starting/token/pending 状态变更之前。
- 原始请求白名单为 text/sessionId/requestId/runId/limits，正文和长参数仅在首条回执保存；后续追加状态差量，读取时合并。
- 状态区分 prepared、accepted、applied、rejected、unconfirmed。applied 指意图进入原生会话、研究已创建或控制入口已处理，并不表示模型或整个研究执行成功。
- 澄清已记录但控制失败时，复用原 entry，再执行尚未应用的控制；已有 accepted/applied 回执禁止重复投递。
- 原生 UserMessage 与 prompt/steer/followUp 贯穿可选 requestId/deliveryId；提供商序列化排除这些内部元数据。
- 新宿主发现旧内存队列仅有 accepted、没有原生投递证明时，报告 unconfirmed；已有匹配原生消息则恢复为 applied。
- 历史请求快照来自完整 durable entries，与压缩后的显示时间线分开，确保重载及压缩后仍使用原始参数。

### 前端与取消

- `C:/frontend-research/Misaka-Agent/desktop/src/lib/researchBridge.ts`：相同请求 single-flight，拒绝冲突 ID，核对提供的宿主身份，保留结构化错误及重试标志。
- `C:/frontend-research/Misaka-Agent/desktop/src/lib/startComposerResearch.ts`：接收、创建确认、快照刷新分别处理；刷新失败返回同步提示而非提交失败。提前订阅创建事件，确认超时核对原宿主。
- `C:/frontend-research/Misaka-Agent/desktop/src/store/useSessionStore.ts`：保留不可变原请求，晚到错误保持接收状态，失败行与持久化行按 ID 对齐；草稿采用逻辑会话、内容、revision 与附件归属保护。
- `C:/frontend-research/Misaka-Agent/desktop/src/components/Timeline/MessageItem.tsx`：显示“已记录”与执行异常，永久错误禁用重试；无 run 且有原始请求的启动执行错误支持同 ID 恢复。
- `C:/frontend-research/Misaka-Agent/desktop/electron/main.ts`：修复启动取消的 abort 路由白名单遗漏。
- `C:/frontend-research/Misaka-Agent/misaka/cli/desktop_bridge.py`：取消待处理研究输入；处理创建与取消竞争，通过原生 stop 门停止已创建的原研究。sessionId/streamId 不匹配的取消在任何副作用之前拒绝。

## 验证结果

新增缺陷均先观察失败断言再实施修复。下列结果来自实际运行，不把不同验证层级混为一谈。

| 层级 | 结果 | 范围 |
|---|---|---|
| 前端完整 Vitest | 62 文件、533 项通过 | 普通对话、设置、研究、输入、工具时间线、会话切换、重试与元数据 |
| 后端研究提交专项 | 90 项通过 | 控制器、ingress、回执、磁盘失败、招募恢复、取消及身份隔离 |
| 后端普通/基础/适配兼容回归 | 191 项通过 | bridge、会话记录、原生输入、prompt assembly、Anthropic 适配 |
| 后端研究生命周期兼容回归 | 93 项通过 | resume、tell、审批、CLI、停止、邮件干预、旧工具结果 |
| 浏览器 E2E（Mock bridge） | 4 项通过 | 研究菜单、窄屏、补充/澄清/追加、研究流程 |
| 真实 Electron/Python + localhost 模型协议夹具 | 3 项通过 | 多段中文/编号原样进入出站请求，模型失败重试不重复原意图，resume 首词保留，waiting_input 停止 |
| TypeScript、生产构建、Oxlint | 通过 | 构建仍有既有大 chunk 提示 |
| 定向 Ruff | 通过（保留既有 TRY004） | 已修改 Python 文件；旧控制工具 payload 校验的 ValueError 契约保留 |
| 实际第三方模型 API | 未验证、未调用 | 尚未确认凭据与预算 |

额外用例 `C:/frontend-research/Misaka-Agent/tests/test_desktop_team_runtime.py::test_real_native_agent_child_uses_desktop_bootstrap_and_exact_team_pair` 返回 Windows WinError 5，保留为未通过验证项。它不是本地 HTTP 模型夹具通过即可替代的验证。

初次并发验证发生测试超时；串行/限制 worker 的重验消除了行为失败。真实 Electron 测试还修复了测试清理：活动研究的退出须走明确 Quit 选择，直接 app.close 会等待产品确认。夹具启动失败也会释放其自有应用。

## 复验命令

工作目录 `C:/frontend-research/Misaka-Agent`：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_continuous_research_backend.py tests/test_continuous_research_runtime.py tests/test_desktop_research_message_entry.py tests/test_research_submission_receipts.py tests/test_desktop_team_bridge.py -q
```

工作目录 `C:/frontend-research/Misaka-Agent/desktop`：

```powershell
pnpm exec vitest run --config vitest.config.mts --maxWorkers=2 --minWorkers=1
pnpm typecheck
pnpm build
pnpm lint
pnpm exec playwright test --config playwright.electron.config.ts electron-research-runtime.spec.ts
pnpm exec playwright test research-workflow.spec.ts research-mode.spec.ts
```

Python 测试通过仓库 conftest 强制使用隔离 MISAKA_HOME；Electron 夹具使用临时 home、workspace 和 user-data。真实第三方验证单独安排。

## 后续现场证据与回滚

- 重启桌面应用后加载新前后端，以同一失败原文复测。若再失败，关联前端 requestId 与后端 `research_submission` 日志的分支、宿主、版本和模型；常规采集继续排除原文及密钥。
- 字段丢失、类型改变或控制包装问题，只修复证据证明的首个偏差边界；保留输入校验与提供商协议边界。
- 原始现场修复结论和真实第三方兼容结论仍待上述验证，未标记整个计划完全验收。
- 回滚仅撤销本次差异并重新构建；保留原用户改动及 JSONL 回执。版本回退后，结果不明的提交先核对原会话，避免自动重复执行。
