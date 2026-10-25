# 研究启动连接错误：通用化修复与验收

日期：2026-10-16\
工作区：`C:/frontend-research/Misaka-Agent`\
分支：`codex/research-tiling-workspace`；保留原有未提交改动，未暂存、提交或推送。

## 修复结果

- 未配置代理时直连；配置代理时按实际目标选择 HTTP/HTTPS/ALL_PROXY，尊重 NO_PROXY、请求级环境覆盖、大小写与显式空值。不扫描端口，不使用代理软件的惯用端口，不静默直连、不切换系统代理或模型。
- 支持 HTTP、HTTPS、SOCKS5/SOCKS5h、本机及远程主机、IPv4/IPv6、认证代理及协议标准默认端口。普通聊天和研究桥接统一保留显式环境。
- Codex WS/SSE 共享固定的请求路由，代理及 CA 变化会隔离旧连接。OpenAI-compatible、Azure、Anthropic 客户端使用显式网络配置；补齐 SOCKS 依赖、HTTPS 代理 CA 和自建 SDK 客户端结算关闭。
- 招募按独立尝试捕获真实模型终态，先处理网络/鉴权/额度等错误，再检查成员数量，覆盖部分招募后失败。超时或取消先发出原生 abort，再取消并结算请求，最后释放重试入口。
- 新增可选 `errorDetails`，保留实际角色、模型、路由、错误原文及真实可用堆栈，凭证脱敏。可选路由诊断异常不会覆盖原始模型错误。
- 独立 `desktop-recruitment` 记录先落盘，保存原始 envelope 和尝试状态，不占用 native delivery receipt。无隐藏 intake 的早期失败也能恢复原课题。
- UI 提供中文摘要、“查看详情”“检查连接”“重试启动”。检查只对实际端点或所选代理做 TCP 探测，发送零应用层字节，明确不代表鉴权或推理成功。
- 同课题重试保留根会话、请求 ID、启动参数；只刷新连接标识，避免重复用户行和重复 Run。旧记录缺少参数时恢复草稿，经用户正常发送和向导确认后再提交。
- 会话索引识别研究根，即使尚无 Run，重启后点击历史也进入原研究宿主，而非普通聊天。原生同请求成功会清除过期启动错误；元数据刷新不会误取消只读打开，真实导航/模型变更仍有身份围栏。

## 主要接口与文件

- `C:/frontend-research/Misaka-Agent/misaka/ai/utils/network_route.py`：请求路由、显式 HTTPX 配置、脱敏与无凭证 TCP 检查。
- `C:/frontend-research/Misaka-Agent/misaka/desktop_research/recruitment.py`：独立启动日志、错误分类、结算与历史投影。
- `C:/frontend-research/Misaka-Agent/desktop/src/components/Timeline/ResearchStartupFailure.tsx`：错误详情、连接检查及恢复交互。
- IPC 新增 `check_research_connection`；错误 ACK 新增可选 `errorDetails`；`list_sessions` 对研究根增加可选 `desktopResearch`。原有协议保持兼容。
- 后端控制器、会话持久化/索引、Electron 启动环境、前端 bridge/store/历史协调同步集成；未重写 DAG 或原生 Run 恢复调度器。

## 最终验证

证据目录：`C:/frontend-research/Misaka-Agent/docs/superpowers/evidence/2026-10-16-research-connection-repair`。

| 检查 | 结果 |
| --- | --- |
| 前端全量 Vitest | **95 文件 /786 测试通过**；`maxWorkers=4, testTimeout=20000, hookTimeout=30000` |
| 后端相关主回归 | **287 通过**；两项重型进程用例另分组执行 |
| 招募、历史、错误 ACK、超时及 receipt 专项 | **42 通过**；与上一组有交集，不累加 |
| 原生 CLI stdio | **1 通过**，隔离 home、占位凭证及显式 shutdown |
| 原生子 Agent 真实进程 | **1 通过** |
| 生产前端服务 → Python JSONL → 本地模型契约 | **1 通过** |
| TypeScript /生产构建 | **`pnpm build` 退出 0**，含 `tsc`、前端及 Electron 构建 |
| Electron 最终组合端到端 | **2 通过，0 失败，0 重试/跳过** |
| 专项 Ruff /依赖锁离线校验 | **通过**；锁文件解析 110 个包 |
| 独立复审 | 网络、后端、前端及最终交叉问题均完成修正并通过复审 |

Electron 两个场景经过生产 preload/IPC/Python/SDK 链路：

1. **直连**：本地模型网关断连 → 真实启动错误 → 展开详情及 TCP 检查 → 网关恢复 → 同请求、同根会话成功创建唯一 Run。
2. **任意端口代理**：本地 HTTP 代理断连 → 保存失败课题 → 正常关闭并重新启动应用 → 从会话列表打开同一研究根与原参数 → 恢复代理 → 同请求重试，原课题仅一条、Run 仅一个。

均使用 OS 分配端口、临时用户目录和本地可控模型服务；没有发送用户真实课题或调用真实远端模型。

## 验证中的测试可靠性修正

- 招募超时测试显式绑定测试主控模型，并挂起真实注入流，不再用会干扰 abort 的假 idle 等待模拟超时。
- 既有审批测试先等待审批按钮真正可用，再点击，避免点击仍禁用按钮的竞态；生产审批逻辑未放宽。
- 无 UI 服务契约先等待真实宿主 ready，再启动研究，避免把 Python 冷启动耗时算进普通命令的 20 秒预算。
- CLI 探针隔离用户 home/凭证，显式 shutdown，使用有界冷启动预算并在超时后清理自有子进程。
- 本机提交内存及负载曾导致组合运行出现 WinError 5、启动或测试超时；采用受限并发、验证级超时及独立进程复验，未调整生产超时、系统权限或系统设置。
- 构建仍有原有大 chunk 提示；不影响成功退出。

## 边界

共享显式路由接入 Codex、OpenAI-compatible、Azure、Anthropic；Google/Vertex、Bedrock、Mistral 的 SDK 专有传输实现保持原样，通用招募错误与桥接环境修复同样生效。本轮未验证真实远端账号鉴权或额度，也没有修改用户代理、系统代理或角色模型配置。代理服务仍需由用户按自身配置保持可用。
