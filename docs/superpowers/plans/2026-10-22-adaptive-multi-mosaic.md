# 多窗自适应拼版：消除主控大空框，支持六成员

## Approved specification
替换主控独占左侧整列的布局，按实际显示人数规整拼版；最多主控＋6真实成员。减少正文末尾到信息栏的被撑空白，不补空卡、不重复内容。12px间距，断点按实际工作区宽度。

| 成员数 | >=1100px | 820–1099px |
|---|---|---|
|0|主控居中阅读卡|主控居中阅读卡|
|1|两窗等宽|两窗等宽|
|2|三窗等宽|主控通栏＋下方双窗|
|3|四窗2x2|四窗2x2|
|4|首行主控2/3＋1成员，次行3成员|主控通栏＋成员2x2|
|5|六窗3x2|六窗2x3|
|6|主控通栏＋成员3x2|主控通栏＋成员2x3|

<820px单列，取消420/360固定高度。行高由内容决定，同排等高；上限clamp(264,(H-12*(rows-1))/rows,420)。长内容原位滚动、正文至少120px，整体不足时外层纵向滚动。仅主控居中复用阅读宽度，高度随内容，上限min(H,720)。缺失主控只摆真实成员，末行均分。

## Global constraints
- 原工作区302既有修改/未跟踪路径，branch codex/research-tiling-workspace / HEAD9a07811。原地完整快照定义本轮审查边界，不以HEAD差异覆盖先前工作；无stage/commit/restore/clean/push/依赖/主题/设置/后端/IPC/数据协议变更。
- 稳定key/portal host；不因宽度/布局重挂。保留唯一Composer/根主控写入/草稿/模式独立读位/工具分页/历史标记/研究控制/Escape与焦点优先级。
- 只根据当前节点实际可展示会话拼版；MRU/置顶6，focused优先，最多7订阅；团队目录打开不额外订阅，focus视图不扩订阅。
- 生产gate在快照、基线、before与新增浏览器行为RED完成前关闭。各任务TDD；全部最终源冻结后串行验证。真实模型用例保持关闭。

## Interfaces / deterministic rulings
- 新纯模块desktop/src/lib/researchMultiLayout.ts导出RESEARCH_MULTI_MEMBER_LIMIT=6；selectResearchMultiSessions(listing,nodeId,focusedId,pinnedIds)沿用现有排序/历史规则，仅把容量增到6。
- getResearchMosaicLayout(width,memberCount,hasController)返回{spans:number[],rowCount:number,columns:6,soloController:boolean}；spans按主控再现有成员顺序，宽断点采用六等分轨道：0=[6],1=[3,3],2=[2,2,2],3=[3,3,3,3],4=[4,2,2,2,2],5=[2,2,2,2,2,2],6=[6,2,2,2,2,2,2]。中断点：0=[6],1=[3,3],2=[6,3,3],3=[3,3,3,3],4=[6,3,3,3,3],5=[3,3,3,3,3,3],6=[6,3,3,3,3,3,3]。窄断点均span6。
- 缺失主控：wide 0=[],1=[6],2=[3,3],3=[2,2,2],4=[3,3,3,3],5=[2,2,2,3,3],6=[2,2,2,2,2,2]；medium每行两窗、奇数末窗span6；narrow全span6。
- researchMosaicRowCap(H,rows,soloController)计算上述上限。Ruling: H<264的物理冲突优先保留正文120与控制区，卡片至少264并外层滚动，避免剪掉控件。空/非有限初始尺寸回退264，不产生NaN/Infinity。
- H取真实layout.clientHeight，不取scrollHeight；width取所在research-tiling-container.clientWidth，不能误用已减边距的网格宽度。只观察工作区/布局尺寸，不按token数量排序或改变跨列。
- 保留[data-research-task-grid]分组与Frame键；可display:contents参与同一网格。全窗展开slot需要保留原占位几何，避免底层滚动位置丢失；Frame只允许最小占位几何修补，不重写现有焦点/IME/inert机制。

## Task 1 — capacity and pure mosaic policy
Own new researchMultiLayout.ts/test, useResearchWorkspaceStore.ts, store/__tests__/researchWorkspace.test.ts. 先观察旧4-MRU的行为RED，再增6并测试所有宽中窄/0–6/缺主控/span完整行/row cap/过量置换/节点隔离/历史标记。不改TilingWorkspace或样式。task1-report.md＋hash manifest＋captured-baseline patch；无提交。

## Task 2 — stable mosaic layout / content sizing
Own ResearchTilingWorkspace.tsx, research-multi.css, new useResearchMosaicSizing.ts/tests (if useful), MultiPaneFrame.tsx及对应最小回归测试、ResearchMultiWorkspace.test.tsx/ResearchTilingWorkspace.test.tsx的批准迁移。Consume Task1接口，接入6成员选择、span与实测工作区行上限；自然短行不撑满整页，同排等高，长正文内部滚动，外层滚动清楚且输入框不遮。仅主控阅读宽度复用--conversation-width。保留frame真实DOM、折叠/详情/读位/唯一Composer。新流式输出不改pane placement/key。TDD先观测root RED与本地行为RED；报告task2-report.md＋manifest＋patch。不得编辑Task1模块/store、Root E2E/fixture、backend/index/materials。

## Task 3 — Root browser / visual integration and release
Root owns新adaptiveMosaicFixture.cjs、adaptive-mosaic.spec.ts、旧multi-polish.spec.ts与pane-details几何断言必要迁移、electron-multi-ui.spec.ts的七窗扩充。先本轮baseline源码/测试/config快照＋定向基线/typecheck；before1440/1280/960/900深浅/sidebar开关＋0–6计数。新增失败测试观察主控跨两行与5/6被裁；生产前RED完成。之后定向/完整单测、production浏览器、Electron夹具、type/lint/build；无真实模型。四成员同fixture空白至少减少50%，短正文末行须实际可见，不能以隐藏正文/截断填充冒充减少。七窗/第七成员置换/订阅限7/目录不扩订阅/节点/缺主控/读位草稿/工具缓存/两级Escape/主题对比度/无blur/减少动态都回归；独立任务审查与最终审查，hash范围审计、同尺寸after和交付报告。保留证据及所有原工作，不自动提交。
