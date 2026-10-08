# 开发桌面主题

桌面主题由 TypeScript 定义和注册。新增主题不需要改业务组件，也没有用户取色器。

## 复制定义 → 注册 → 选择

目前客户端内置以下 4 个主题系列（共 8 款主题）：
- **默认经典 (Misaka)**: `dark`（深色）、`light`（纯白底玫红）
- **天空 (Codex 科技蓝)**: `codex-light`（纯白底青蓝）、`codex-dark`（深邃曜石蓝黑）
- **羊皮纸 (Claude 书卷暖调)**: `claude-light`（纯白底暖陶）、`claude-dark`（焙茶炭褐暖琥珀）
- **森林绿 (Forest)**: `forest-light`（纯白底森林绿）、`forest-dark`（幽林苍翠墨绿）

现有四套浅色主题的主画布、面板、研究图谱和窗口背景统一为 `#ffffff`；图谱缩略遮罩为 `#ffffffb3`，保留原透明度。浅色模式隐藏全屏氛围渐变，深色模式保留原效果。主题特色用于强调色、按钮、链接、焦点边框，以及控件、代码块和悬停态的局部浅色层次，避免大面积染色。自定义主题仍可通过颜色角色独立定义背景，不会被强制覆盖为白色。

1. 复制 `desktop/src/theme/examples/ocean.ts`，修改唯一 `id`、显示 `label`、`mode` 和颜色。
2. 在 `desktop/src/theme/registry.ts` 导入定义，将其加入 `createThemeRegistry([darkTheme, lightTheme, oceanTheme])`。
3. 重启桌面开发进程或重新构建。在“设置 → 外观与主题”选择新主题。

`mode` 决定浏览器原生控件的深浅模式，并控制全屏氛围渐变（浅色隐藏、深色保留）；主题 ID 可以是任何小写字母开头、由小写字母、数字、连字符构成的名称。新增颜色主题时不添加 `[data-theme="ocean"]` 样式或主题名分支。

## 完整配色契约

`theme/tokens.ts` 中的 `PALETTE` 是全部颜色角色的清单，`ThemeColors` 为全部角色的必填类型。推荐复制完整内置主题，再覆盖任意角色；复制不表示运行时逐项回退。注册时会保存不可变完整快照，避免外部改动产生半套配色。

颜色只接受 `#RRGGBB`、`#RRGGBBAA` 或 `transparent`；八位十六进制的后两位是透明度。变量引用、CSS 表达式、终端调色板编号和命名色均不属于桌面主题格式。错误格式、缺失角色、非法 ID 或重复 ID 会输出带主题 ID 和角色的诊断，该定义不进入列表；重复 ID 的所有定义均排除。

颜色角色分组：
- `surface-*`、文字、边框、强调色及 `on-accent`、`on-danger`、`on-chart`。
- 成功、警告、错误、信息及相应背景和边框；权限徽标、复制提示与活动灯。
- Markdown、工具结果、滚动条、遮罩、开关、滑条和流光。
- `chart-*`、`graph-*`、供应商 `brand-*`。
- 阴影颜色、玻璃高光 `glass-highlight`、凹陷背景、`window-background` 和 `window-symbol`。

阴影层数、渐变形状、混合比例、圆角、布局、字体和阅读字号保持独立。主题可定义每个已有角色，不需要为了背景是浅色而强制使用白字。用户内容中的图片颜色不重染。`rose` 和 `rose-lite` 只是 `accent` 和 `accent-soft` 的兼容 CSS 别名。

## 新增颜色角色

只有引入新的视觉角色时才需要扩展代码：在 `PALETTE` 中补齐内置深浅默认值，消费者使用对应 CSS 变量；Tailwind 工具类在 `index.css` 的 `@theme inline` 中映射。需要传给 SVG/Canvas 的解析值同时加入 `useThemeTokens`。更新 `index.html` 的首屏角色清单；自动测试会检测清单遗漏。所有独立完整主题需补齐新角色，复制内置主题的定义会自然获得默认值。

## 玻璃材质与主题柔光

八款内置主题共用三种显式选择的玻璃外壳，样式位于 `desktop/src/styles/materials.css`：
- `misaka-glass-chrome` 用于顶部栏、工作区标题栏、侧边栏和设置导航，模糊为 16px，浅色/深色背景不透明度分别为 90% / 84%。
- `misaka-glass-panel` 用于输入框、设置分组卡片和节点详情抽屉，模糊为 20px，背景不透明度为 88% / 82%。
- `misaka-glass-popover` 用于菜单、模型选择器和弹窗外壳，模糊为 24px，背景不透明度为 94% / 90%。

底色由 `surface-1` 派生；局部反射使用最多 6% 的 `accent`，顶部高光使用 `glass-highlight`（浅色 `#ffffffcc`，深色 `#ffffff24`）。`misaka-luminous` 为主按钮、选中主题卡片和键盘焦点提供主题色柔光。效果直接启用，不增加主题 ID、材质开关或保存字段。

正文、代码、表格、工具输出、研究节点和报告内容保持实底；嵌套设置卡片不重复模糊。装饰线不接收鼠标事件，也不增加容器裁剪。缺少 `backdrop-filter` 支持时外壳使用不透明主题底色；减少动态效果设置下关闭材质和柔光的 180ms 过渡。浅色主画布和图谱仍为纯白，全屏氛围渐变继续隐藏。

玻璃会创建新的层叠上下文和固定定位包含块。侧栏重命名弹窗通过 Portal 挂载到 `document.body`，保持全窗口遮罩；工作区标题栏使用明确层级，保证会话菜单位于正文之上。柔光控件保留独立的 2px 键盘焦点轮廓。

常驻框架与悬浮面板使用不同反光分布：顶部栏和侧栏以主画布为底，共用锚定视口的柔光，避免每个区域重新开始一束光；框架不使用浮卡投影或重复亮边。输入框和设置面板采用弧形散射反射，而菜单与弹窗保留更明显的玻璃高光。输入区常态描边轻淡、聚焦反馈清晰，底部采用不接收事件的渐隐底层与正文衔接；欢迎页不叠加该底层。模糊、不透明度和主题配色保持不变。

## 窗口、保存与终端兼容

React 与 Electron 使用同一注册表。`window.theme.listThemes()` 返回 `{ id, label, mode }`，既有 `getTheme`、`setTheme`、`onChange` 继续使用 ID；主题数据中的 `name` 仍是 ID，并新增 `label`、`mode` 和完整 `colors`。

选择保存在 Electron `userData/desktop-theme.json`，兼容已有 `{ "name": "dark" }` / `light`。已删除的主题回退到内置深色。写入通过临时文件和重命名完成，失败保留旧记录和当前主题。完整配色通过受校验的启动数据在首次绘制前写入根节点，窗口背景和标题栏同步使用主题颜色。

八位背景色传给 Electron 时转换为该 API 的 ARGB 顺序；标题栏仍使用 CSS RGBA 顺序。实际窗口透明效果受平台和非透明窗口配置约束，本功能不修改窗口类型。

桌面自定义主题不会写入终端设置；仅内置 `dark` / `light` 延续原有终端同步。终端 JSON 主题文件不再是桌面配色来源。

## 验证

在 `desktop` 中运行 `corepack pnpm typecheck`、`corepack pnpm test`、`corepack pnpm build` 和 `corepack pnpm exec playwright test e2e/theme.spec.ts e2e/glass.spec.ts e2e/lightBlend.spec.ts`。

颜色扫描测试覆盖生产组件、首页与样式，禁止固定可见颜色。仅遮罩中的不透明黑色和透明形状值例外。高辨识度验收主题仅存在于测试夹具，验证实际计算样式、菜单、状态、弹窗和图谱切换，不加入正式主题列表。
