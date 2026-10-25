# 研究工作台 UI 精修记录

日期：2026-10-16

## 范围

按已确认的“克制、精密的深色研究调度台”方向，在原多智能体实现上精修前端。保留现有深色外壳、玫红品牌色、菜单、普通聊天，以及原生调度、审批、恢复、真实遥测来源；本轮未修改 Python 或后端协议。

## 交付

- 运行概览：课题、Run ID、真实运行/就绪/完成数量、阶段、节点切换和原有研究图谱入口。
- Agent 窗格：角色图标、明确文字状态、较大的正文与行距；主控紫色窄边、工具紧凑分层、最终报告独立阅读面。
- 渐进披露：阶段指令、初始卡片任务说明、完整契约、停止记录和遥测详情可展开，原始内容均保留。
- 侧栏：复用研究会话树，当前执行与历史代次分开呈现；默认窗格优先当前执行，手动聚焦历史执行仍保留固定窗格与阅读状态。
- 全停提示：短摘要与醒目的恢复操作，完整逐卡确认和原生 resume 指令仍可查看。
- 九项向导：按“研究范围 / 并发与审批 / 上下文与输出”分组；保留原生默认/边界，提供有名称的深度预设，支持 Escape、Tab 循环和关闭后的焦点/草稿保留。
- 主题：全程使用既有语义颜色和系统字体，无外部字体或图像依赖。研究区的次级字色与错误字色采用主题派生混色，加强浅色模式对比；普通聊天样式不变。
- 自适应：宽窗口主控跨两行；紧凑窗口主控在上、专家两列；更窄工作区单列。窄布局主控420px最低阅读空间，专家300px；桌面专家行最低260px。正文保底80px，契约和遥测展开后各自滚动，页脚保持在窗格内。

## 主要文件

- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchRunHeader.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchStatusBadge.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/researchPresentation.ts`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchTilingWorkspace.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchAgentPane.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchSessionTree.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchStoppedBanner.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchRunWizard.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/ResearchWorkspace/ResearchPaneFooter.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/src/styles/research-workspace.css`
- `C:/frontend-research/Misaka-Agent/desktop/src/components/Sidebar/Sidebar.tsx`
- `C:/frontend-research/Misaka-Agent/desktop/e2e/electron-research-tiling.spec.ts`

## 验证

先增加行为测试，观察5项新界面行为失败，再实现；初始任务说明的折叠单独记录失败后实现。定向用例34项通过，类型检查和 lint 通过。最终全量前端 **93 文件 / 748 项通过**（`vitest-final.log`）；最后一次构建含 tsc、Vite、Electron 主进程与 preload 均通过，保留既有大包体积提示。

原生 Electron 用本地可控模型服务，经过429全停、关闭重开、同 Run 恢复并显示完整报告的真实链路；本轮几次完整运行均通过，含新增截图/几何检查的一次1 passed，2.3分钟。

截图覆盖1440×1000、1200×850、960×820，深/浅色主题和向导；减少动画模式下，检查正文高度≥80px、页脚不越过窗格边界、页面无横向溢出。契约与遥测同时展开时也检查几何边界。独立审查复现并推动修复了960px正文被固定区域挤占的问题，819.5px分数断点同样补查通过。

最终纯色对比调整后的截图补采，复用已完成的隔离 Run，不请求模型，额外验证主题、分数宽度、Escape取消和草稿保留。该截图补采不替代原生研究闭环测试。

证据目录：`C:/frontend-research/Misaka-Agent/.superpowers/sdd/research-ui-polish-2026-10-16/`。
截图：`screenshots/workspace-dark-1440.png`、`workspace-dark-1200.png`、`workspace-dark-960.png`、`workspace-light-1440.png`、`wizard-dark.png`、`wizard-light.png`。

## 审查与保留

独立审查在紧凑高度与分数断点修复后 SPEC / QUALITY 通过。历史行进一步显示代次/执行序号、外部聚焦时自动展开历史分组，作为后续可选细节；目前历史内容完整保留且可展开，窗格标题保留执行序号。

保留原有未提交改动、原分支和本轮修改前基线。未自动暂存、提交、合并或推送。


## 最终结果

- 定向测试34项通过；全量93文件748项通过。
- typecheck、前端 lint、生产构建通过。
- 原生 Electron全停→重启→同 Run恢复→交付报告显示通过；加测窄布局正文与页脚几何、同时展开契约和遥测详情、深浅色、键盘取消与草稿保留通过。
- 最终截图补采3种尺寸+819.5px分数断点通过；分数宽度正文164.9px、页脚无越界。已人工查看宽屏、紧凑、浅色与向导截图。
- 本轮保持现有分支和原有改动，未暂存/提交；比较基线与诊断证据保留在上述本地目录。
