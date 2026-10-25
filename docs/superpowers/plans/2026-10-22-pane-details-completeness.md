# 多窗第二轮精修：底栏收敛，主控信息补全

## Approved design
底部常驻仅上下文百分比＋详情入口；主控保留原始消息顺序、完整工具字段、错误与报告状态，并修复长内容续读。用户已明确同意显示层与长报告读取一起修复，接口及数据格式保持原样。

## Global constraints
- 保留现有多窗布局、四成员容量、八主题、根主控写入目标、唯一Composer、草稿、模式独立读位、MRU/历史成员、研究控制与App订阅生命周期。
- 当前功能分支工作树有296个既有修改/未跟踪路径。继续在原工作区，捕获快照隔离审查；无暂存/提交/合并/推送/依赖/设置项变更。
- IPC shape、content field enum、Unicode codepoint游标、UTF-8响应大小限制、脱敏与数据格式保持原样。读取层生产修改仅desktop_view.session_content相关取值bug。
- 不整体换用focus renderer（其研究通知过滤/截断续读与multi不同），复用既有blocks/format/redaction基础，所有display=false语义保留。

## Task 1 — Quiet footer and detached details
- ResearchPaneFooter32px安静系统字体bar，左上下文N%/未知—，右详情；模型长名/Token比值/费用/权限全部退出bar。真实0与unknown区分，不推算未知percent。
- 完整数据放body-portal玻璃浮层，模型/上下文/用量/运行信息分组，长值换行可选取；宽度约360并夹取viewport，maxheight有界滚动，不挤正文。
- useAnchoredLayer增加opt-in placement/collision选项，默认旧行为保持。Footer优先above、必要翻转、8px视口边界，跟随pane/ancestor resize与scroll，不只观察固定宽度小button。
- useDismiss/既有Escape层管理。等前景所有权交接后聚焦浮层，Escape/关闭回详情button；退出全窗前先关闭浮层，不触发研究stop。
- MultiPaneFrame仅补前景关闭时若焦点已在host内则保留，避免把footer trigger抢回expandbutton；其它portal/scroll/IME/inert逻辑保留。
- Own: ResearchPaneFooter.tsx/test、newPopover component/tests ifneeded、useAnchoredLayer.ts/targetedtests、MultiPaneFrame.tsx andnewFooter integrationtests、research-panes.css FOOTER section only (other sectionsunchanged)。不用改AgentPane/index/E2E，optional footer sessionLabel prop由Task2接。
- TDD观察旧bar过载/inline details/edge collision/focus handoff的red，再实现与green；报告task1-report.md+manifest。

## Task 2 — Ordered complete controller content and robust paging
- ResearchAgentPane按canonical blocks原序呈现text/thinking/tool；不再将text全拼在前后放工具。保留non-assistant/custom original语义和stream flags。
- tool闭合仍紧凑；展开分别呈现args/partialResult/result/details/error，互不遮蔽；args/result/error截断字段沿原content API分页，details/thinking未支持续读时明确预览状态，不新增field enum。
- 显示assistant.errorMessage、report.details.incomplete与已有原因，研究设计摘要显示done/total+running，避免完成后只剩0。
- 单正文截断原位续读；多text块截断保留原序预览并提供明确完整正文续读区，不将aggregate fullbody错误塞到首text块。
- 独立per-run/executor/entry/field分页缓存及inflight/epoch fences；首次续读不缩短已有preview、不重复，不空读wipe；成功要出现新增内容或明确完整状态，错误就地retry。按server nextOffset，不用JS UTF16.length推导游标。
- 更旧历史prepend、续读、展开内容保留可见锚点；following跟最新、非following留住当前内容。保留既有跨模式reading与全窗重挂scroll机制。
- Own: ResearchAgentPane.tsx/test、新分页/reading helper与tests（命名自定报告明确）、ResearchLastOrderOverview.tsx/test、新content CSS若确需由Root接import。Footer API仅新增optional sessionLabel?:string，由Pane传title；不得改Task1文件/useAnchoredLayer/MultiPaneFrame或其它store/协议。需store缓存补充先与root确定最小字段。
- 原工具folds/previews/contentOffsets的现有缓存不丢失；args/result/error使用独立key，不互相复用同一buffer。
- TDD正文工具交错/所有fields/独立error/incomplete/32KiB中文emoji/空响应与retry/旧页锚定；报告task2-report.md+manifest。

## Task 3 — Session full-content read correction
- 已在planning只读probe复现48k中文custom_message读取TypeError，而普通message分页成功。custom body在entry.content，普通在entry.message.content。
- 修正session_content统一读取这两种形状，str/list/empty安全；保留toolargs/result/error分支、run/executor scoping、redact、bytebudget和codepoint offsets。
- Own: misaka/core/research/desktop_view.py（仅相关函数最小diff）；tests/test_research_desktop_view.py或新增readcontent专测（不改其它生产）。不得添加新API/字段/路径越权读取。
- Python TDD newcustom final/phase/empty/list/multi-pageCJKemoji和已有normal/tool/scoping/redaction兼容；报告task3-report.md+manifest。

## Task 4 — Root integration / review / release
- Root ownsindeximport(ifnewcontentCSS)、newE2Efixture/spec、existingE2E迁移旧inline footer断言、nativefixture补metadata popup与ordered content验证；不碰worker-owned代码除reviewfix必须。
- 先捕获source/backend/tests/config baseline+基线检查，before画面；newacceptance red后释放production gate。Workers各自test-first，再green+selfreview，独立taskreview/fixloop与finalintegratedreview。
- 深浅色1440/1280/960/900、sidebar on/off、4panes+controller，Footer上下文百分比/详情无clipping、Popoverabove/flip、全部model/values可读且bodyheight恒定。
- Expanded下focus进popover、Escape只关闭popover返trigger、第二次收起pane，higherdialogs优先，研究运行；换节点/模式popup关闭且迟到页不串。
- 真实canonical sequence、report/args/error并存、>32KiBCJK/emoji跨页完整性、nativeerrorsretry、historyprepend锚定及draft/uniqueComposer regression。
- Frozen source上serial全量frontendunit、定向backendunit+相关regression、type/lint/build、ALLproductionbrowser、Electronrendererfixtures；真实模型opt-in维持既有开关，不宣称真实backend研究生命周期已跑。
- 验证hash一致性、截图和交付报告，保留当前branch/HEAD和既有work，无自动提交。

## Rulings
- 原干净worktree会丢失前几轮未提交UI基线；使用完整捕获workingtree snapshot审查，不用HEAD差异包揽用户已有work。
- Footer独立浮层替换inline details后，旧测试断言仅按明确新契约迁移，保留data/operation assertions。
- Backend修复属本轮用户明确选择的完整性范围，不扩到调度/driver/model，不改变wire或预算。
