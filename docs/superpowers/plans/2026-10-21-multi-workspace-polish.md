# 研究多窗精修：顶部直达，主控＋四任务窗

## Approved design
用户已批准本轮完整实施：两种研究视图共用52px玻璃工具栏，常驻32px专注/多窗分段切换；多窗是当前节点协调主控＋最多四个成员窗口。无重复顶部、无凑数空卡、默认折叠技术信息，外壳同源柔光、正文实色清晰。

## Global constraints
- 在当前codex/research-tiling-workspace工作区保留所有既有修改；不暂存、提交、合并、推送或新建干净worktree。
- 无后端、IPC、数据协议、新依赖、新主题或新设置。保留根主控写入目标、唯一Composer、草稿/附件、独立读位、工具分页缓存、历史成员、四个MRU pins和App订阅生命周期。
- 不借视觉改动统一focus/multi两套读位；目录展开不订阅全部成员。审批、澄清、异常与停止/恢复待确认反馈保留。
- 浅色canvas纯白、八主题、语义色、系统字体、Lucide、无blur回退和reduced-motion保留。普通聊天不变。

## Task 1 — Shared research toolbar and directory
- 推广现有ResearchFocusToolbar为两模式共用组件，内部接口mode/onModeChange；保留既有focus测试标记，新增通用toolbar标记。
- 顺序：课题、团队、run状态、适用停止/恢复、32px专注/多窗分段、More。窄空间图标化并保持可访问名称；长标题让位，完整问题可查。
- App在timeline+bound run时隐藏旧workspace header，不区分focus/multi；graph/ordinary保留原header。
- More删除重复切换项；节点/图谱/工作区/设置/详情保留；两模式过程菜单均可用（容器由Task3配套渲染）。加载/empty/error仍有统一toolbar。
- Team的onOpenSide可省略；multi不显示侧读，member action走现有focusExecutor（节点、MRU、历史语义），focus仍setMain/setSide。返回根主控在multi使用真实root descriptor。
- TDD；仅处理owned files及新research-toolbar.css，不改ResearchTilingWorkspace或旧research-workspace.css。Root统一接入新CSS。

## Task 2 — Reading-first panes
- ResearchAgentPane标题行44px左右：单一成员名、状态、正常布局中的32px展开入口；根主控/节点主控明确区分，历史标记保留。选中态细边框无光晕。
- 正文跟随--font-size-base；辅助文字约12px。主控研究设计、任务说明默认折叠，完整native任务/依赖/契约仍可访问。
- 工具关闭仅名称/状态，无6行预览；展开保留原分页/folds，失败提示仍外显。
- footer约32px安静details入口，摘要仅已知model/context；全部tokens/cache/cost/compact/permissions/path移入details。0与unknown区分，不铺满问号。详情内部滚动，配合布局保留正文120px。
- AgentPane增加可选isRootController/expanded/onToggleExpanded展示props（最终接口以brief约定），不自行接管订阅/模式/全屏生命周期。Root负责expanded层Escape/focus与容器。
- TDD；owned pane TSX/tests +新research-panes.css，不改现有workspace CSS/index或toolbar。

## Task 3 — Responsive workspace integration and acceptance
- Root负责ResearchTilingWorkspace：两模式和loading/error共用顶部；multi原RunHeader/独立toolbar移除，过程面板默认折叠。现有审批/停止banner只呈现一次。
- 根壳层multi也透明接入全局柔光，正文卡片保留surface-1实色无blur；更新旧multi实底断言为新契约。
- 实际host宽度>=1100：主控360px＋任务2列；820–1099：主控clamp(320px,36%,400px)＋任务1列独立滚动；<820：外层纵滚，主控420px、成员360px。gap12px，wide任务行min280px。
- 0–4成员只排实际卡片；3成员最后跨2列；只有主控时铺满并有一条暂无成员说明；无主控时任务区占满，无虚构主控。
- 根据--composer-height预留底部空间，唯一Composer不搬动或remount，所有卡片footer在输入区上方。
- 保留expandedExecutorId全窗展开范围，使用portal/body-level modal壳层避免新增toolbar backdrop-filter改变fixed containing block；前景dialog/menu高优先级，Escape先关闭前景、再收起pane，focus返回入口，不停止研究。适当focus管理，不侵占已有前景。
- Root接入3个CSS文件至index：research-toolbar.css/research-panes.css/research-multi.css；owned new integration CSS和容器/E2E/tests，其他生产文件不并行改。
- 捕获工作树baseline与定向测试；新增布局/控制/Escape的失败用例后实现。覆盖1440/1280/960/900/sidebar开关拖宽/long title/0–4/缺LO/历史/生命周期。

## Task 4 — Review and release
- 各任务对本计划捕获snapshot做独立spec+quality review，不用HEAD差异吞入已有工作。
- 定向单测、production fixture E2E、8theme真实背景contrast>=4.5、fallback/reduced-motion、独立读位/草稿/MRU/watch及native renderer regressions。
- 最终冻结源文件后串行fullunit/type/lint/build/browser/Electron UI；真实模型测试维持既有opt-in，不宣称真实后端生命周期验证。
- 深浅色多窗前后截图、hash一致性、交付报告和ledger；保留证据、当前分支与未提交工作。

## Execution rulings
- 当前功能基线含大量未提交文件，新建干净worktree会遗漏已批准UI；以捕获快照隔离review，不重置用户工作区。
- Shared toolbar class/marker可保留focus前缀降低回归；mode/onModeChange是实际权威，不新增mode状态。
- 窗口展开涉及原有全窗fixed语义：与任何新增backdrop-filter祖先隔离，不让全窗被局限在卡片/任务区。
- 新CSS按本轮三个子系统分文件，避免并行改同一54KB样式文件；定向覆盖必须集中且以作用域限定，不堆叠多次修补规则。
