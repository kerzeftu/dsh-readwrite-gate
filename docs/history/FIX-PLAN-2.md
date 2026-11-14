# 修复计划 2：目录选择器、写⇒读、路径智能识别

## 0. 验收原话

> 要修复添加额外可读写文件添加目录或文件不能成功打开目录选择器的问题，并且允许写的文件要默认允许读取，并且手动输入路径要实现智能识别，比如带引号的，有一些省略的，各种格式都能自动识别并更改，查找问题所在，计划修复，写md

三个问题都要先定位到证据，再改。

## 1. 问题定位

### 1.1 「选择目录…」打不开：本机目录选择后端是 browse，`pick` 被拒绝

证据链（全部来自本机运行事实）：

1. 本机 Harness 进程（pid 1042）环境里有 `DISPLAY=:0`、`WAYLAND_DISPLAY=wayland-0`，但 PATH 里**没有** `zenity`/`kdialog`（`which` 为空）。
2. profile 的 bundles 是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`；`dsh-web-app/cordis.patch.yml:113-114` 启用 `@deepseek-ai/dsh-host-directory-picker-auto`。
3. `dsh-host-directory-picker-auto/lib/index.js` 的 `resolveDirectoryPickerBackend()`：`native` 需要 bindHost=`127.0.0.1`、非 SSH 启动、linux 上还要 `DISPLAY`/`WAYLAND_DISPLAY` **且** PATH 里有 chooser 二进制；否则一律 `browse`。⇒ 本机解析结果是 **browse**。
4. `dsh-api-workspace-controller/lib/index.js:483` 的 `pick` 走 `requireCapability("native", "pick")`；同文件 :416 注释明说 “a verb the composition cannot serve is refused rather than approximated”。⇒ browse 后端下 `remote.directoryPicker.pick()` **必然失败**（Remote 返回 `ok:false`）。
5. 插件 `client.js:1116` 声明 `remote.directoryPicker`、`client.js:1175` 调 `ctx.remote.directoryPicker.pick()`：调用形状本身没错（`dsh-client-ui-workspace/lib/client.js:4768` 也这样 inject），错在**前提假设**——以为 `pick` 一定可用。
6. 面板的错误路径把它吞成一行提示（`client.js:1173-1181` 的 catch 写出“无法打开目录选择器（…）；请改用‘手动输入路径’。”），所以用户看到的是“点不开”。

browse 后端真正可用的原语（同一 Remote 命名空间）：

- `remote.directoryPicker.list(path?)` ⇒ `DirectoryListing { path, home, crumbs, entries: [{ name, path, hidden }], truncated }`——`entries` 是**子目录**（`dsh-host-directory-picker-browse` 只收 directory 与被跟随的目录符号链接，见其 `lib/index.js:182-209`）；
- `remote.directoryPicker.createDirectory(path, name)` ⇒ 新目录绝对路径；
- 客户端还有包装服务 `ctx.uiWorkspace.listDirectory(path?)`（`dsh-client-ui-workspace/lib/client.js:1529`，失败抛 `DirectoryBrowseError`）。

另外：`@deepseek-ai/dsh-client-ui-directory-picker-browse` 是这套 browse 交互的客户端面，它只占 `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` 两个洞（宿主“打开工作区文件夹”流程），**无法被插件复用**。

⇒ 修复方向：面板自建目录浏览器（`list`），`pick()` 只作为原生后端可用时的快路径：先试系统对话框，失败即回退到内置浏览器，并把回退原因显示为一行说明（不是报错死路）。

### 1.2 「允许写」不隐含「允许读」

- `grantedPathsOf(session, kind)`（`index.js:495-497`）只按 `row[kind] === true` 过滤；`extraRowsOf`（`index.js:472-493`）的 `read` 也不包含 `write`。
- 后果：授权页对“修改”选“总是”（或 `add-write`）后，同一目录**读**仍逐次弹授权页；`/access-allow list` 里该行只显示“写”。
- 现有测试 `check-gate.mjs` 的 “the write side passes without a dialog / add-write grants no reads” 断言的正是旧语义，需要随需求改写。

⇒ 修复方向：读侧匹配用 `effectiveRead = read || write`；面板读框按 `effectiveRead` 列出并标“读+写”；写行的读**不单独撤销**（读框里该行 ✕ 禁用并说明“读由写隐含”，撤销要去写框）。

### 1.3 手动输入路径不识别格式

`index.js:863-897`（`allowCommand` 的 `add`/`add-write`）现状：

- 只做 `trim()`；`~` 开头**直接报错**（:865 “不支持 ~”）；
- 无引号剥离（`"/etc/hosts"` 会把引号当路径一部分）、无 `file://`、无反斜杠转义处理；
- 无相对路径解析（相对路径按字面存）、无 `.`/`..`/重复分隔符折叠；
- 无存在性/类型校验：不存在的路径也能加、目录/文件只能靠用户自己敲结尾 `/`（:874 注释自认 “A trailing separator is the one signal a typed path carries”）；
- 读侧存进 `readAllow` 的**字符串数组**（`index.js:622-642`），没地方存“这是目录”，只能用尾斜杠约定；写侧存进 `grantEntries`，有 `directory` 但同样只凭尾斜杠。

⇒ 修复方向：新增纯函数 `normalizeUserPath(raw, { root, home })`（`functions.js`）+ 宿主 `stat` 校验（`node:fs/promises`），把“用户怎么写”与“系统怎么存”解耦。

## 2. 修复设计

### 2.1 面板目录浏览器（client.js）

- 新增 `DirectoryBrowser` 面板（挂在 AllowControl 内部，同层 `position: fixed`，宽 340、`maxHeight: 60vh`）：
  - state：`{ open, family, path, listing, busy, error }`；
  - 数据：`props.listDirectory(path)` ⇒ `ctx.remote.directoryPicker.list(path)`（inject 已声明该命名空间，不用新增依赖）；
  - 界面：标题（“选择目录”）、面包屑（`listing.crumbs`，可跳转）、子目录行（`listing.entries`，可进入）、当前目录行高亮、“选择这个目录”按钮、“上一级”、关闭 ✕、错误行；
  - `listing.truncated` 为真时显示“仅显示前 N 项”提示。
- 交互：`选择目录…` 按钮 ⇒ `choose(family)`：
  1. 先试 `props.pickDirectory()`（原生后端可用时就是系统对话框）；
  2. 失败（Remote `ok:false` 或抛错）⇒ 打开内置浏览器，顶部一行说明“本机没有系统目录对话框（browse 后端），已切换到内置浏览”；
  3. 浏览器里选中 ⇒ `add(path, family)`（路径规范化由宿主做，见 2.3）。
- 加号菜单 `extra-readable-files`（`client.js:1216-1254`）：菜单动作没有面板宿主，改为通过模块级 `requestBrowser(sessionId)` 事件通知已挂载的 AllowControl 打开浏览器（AllowControl 订阅、卸载时取消；会话 id 必须匹配）。
- 新文案（DICT，`client.js` 的 `zh`/`en`）：`browseTitle`、`browseCrumbHome`、`browseUp`、`browseChoose`、`browseEmpty`、`browseLoading`、`browseTruncated`、`browseFailed`、`pickFallback`。

### 2.2 写⇒读（host + client）

- `index.js`：
  - `effectiveRead(row) = row.read === true || row.write === true`；
  - `grantedPathsOf(session, 'read')` 用它（闸门读侧 `grantedBy` 自动跟随）；
  - `extraRowsOf` 行增加 `readable`，`read` 保留原始语义（存储意图），面板显示读 `readable`；
  - `familyText(row)` 对 write 行输出“读+写”；`levelText` 的额外路径列表同；
  - `add-write` 输出文案改为“已添加 …（读+写）；本对话读取与修改该路径时都不再逐次询问”；
  - `remove-read` 命中 write 行时不改状态，返回提示：“该路径的读权限由写权限隐含；如需撤销请用 remove-write 或 remove”；
  - `remove-write` 命中 read+write 行 ⇒ 行变“读”，`remove` ⇒ 整行移除（现有逻辑已覆盖）。
- `client.js`：
  - `parseAllowMarker` 增加 `readable`（`r` 位或 `w` 位都算可读）；
  - 读框 `rows = list.filter((row) => row.readable === true)`；写框仍按 `row.write`；
  - 读框里 write 行的 ✕ 禁用（`disabled`、`title` 说明“读由写隐含，请在可写框撤销”）；写框 ✕ 保持可用；
  - 面板标题计数用“可读 N / 可写 M”（`readable` 计数）。
- 闸门语义：`readAllow`（配置/手输白名单）仍只读；写授权（会话授权或 `add-write`）**同时**放行读，因为它们都进入 `grantEntries`。

### 2.3 路径智能识别（host：functions.js + index.js）

新增 `functions.js` 导出：

```js
export function normalizeUserPath(raw, options = {})
// => { path: string, directory: boolean, reason?: string }
```

规则（纯函数，无 IO）：

1. 去首尾空白；空 ⇒ `reason: 'empty'`。
2. 剥成对引号：`'` `"` `` ` `` `「」` `『』`（可多层），按对剥，不配对的保留。
3. 反斜杠转义：`\ ` ⇒ 空格、`\"` ⇒ `"`、`\\` ⇒ `\`（POSIX）；Windows 形态（`^[A-Za-z]:\\` 或 `^\\\\`）在 win32 上把 `\` 统一成 `/`。
4. `file://`（含 `file:///`）剥掉，百分号解码（失败保留原文）。
5. 展开 `~`、`~/…`、`$HOME`、`${HOME}` ⇒ `options.home`；`~user` 不支持 ⇒ `reason: 'unknown-user'`。
6. 折叠 `.`、`..`、重复分隔符；尾分隔符记录 `directoryHint = true`（保留语义，不落存储）。
7. 相对路径 ⇒ 按 `options.root` 解析（工作区根）；`options.root` 缺失 ⇒ `reason: 'no-root'`。
8. 含 `\0`、长度超过 4096 ⇒ `reason`。
9. `path` 输出为**未做 realpath 的绝对路径**；目录标志由宿主 `stat` 决定（存在时）。

宿主 `index.js`（`allowCommand` 的 `add`/`add-write`）：

1. `normalizeUserPath` 失败 ⇒ `{ kind: 'error', text: '无法识别路径“<原输入>”：<原因>' }`。
2. `stat`（`node:fs/promises`）：
   - 存在 ⇒ `realpath`，`isDirectory()` 决定 `directory`；目录在存储时补尾分隔符（读侧 `readAllow` 用尾斜杠表达目录；写侧 `grantPaths(..., { directory })`）；
   - 不存在 ⇒ 读侧报错“路径不存在：<path>”；写侧允许（提示“目标尚不存在，将按文件处理”），`directory` 取 `directoryHint`。
3. 存储前把 `readAllow` 中原有的非规范条目与新增条目共存（不批量迁移；`remove` 的匹配已容忍尾分隔符）。
4. 返回消息带识别结果：“已识别为 /etc/hosts（文件）；本对话读取该路径时不再弹出授权页”。

客户端不重复实现这套逻辑：`addAllowed` 把用户原样输入交给宿主 `/access-allow add`，错误行显示宿主返回的文案；面板列表刷新后就是规范化后的绝对路径。

## 3. 逐文件改动清单

| 文件 | 改动 | 位置 |
|---|---|---|
| `client.js` | `choose()` + 回退；`DirectoryBrowser` 组件（约 130 行）；读框 `readable` 过滤 + ✕ 禁用；`parseAllowMarker` 加 `readable`；菜单 run 改 `requestBrowser`；DICT 新文案 | :493-499、:504-581、:583-608、:1137-1183、:1216-1254、DICT |
| `index.js` | `effectiveRead`；`extraRowsOf.readable`；`familyText` 读+写；`grantedPathsOf` 读侧；`add`/`add-write` 用 `normalizeUserPath` + `stat`；`remove-read` 提示；`add-write` 文案 | :396-520、:622-642、:838-930 |
| `functions.js` | 新增并导出 `normalizeUserPath`（约 90 行）；复用 `directoryOf` | 文件尾 |
| `locale/zh.json`、`locale/en.json` | 只含 bundle meta，客户端文案在 `client.js` 的 DICT；meta 不变 | — |
| `README.md` | 新增“目录选择器（browse 回退）”“写包含读”“路径识别”三节 | `## The control` 之后 |
| `FIX-PLAN-2.md` | 本文件；实施完成后补 `## 7. 实施状态` | — |

不改 `cordis.patch.yml`：没有新配置项（写⇒读与路径识别都是行为修正）。

## 4. 测试矩阵

**check-panel.mjs**
- stub `remote.directoryPicker.pick` 返回 `{ ok: false, error }`、`list` 返回 listing ⇒ 点“选择目录…”后浏览器渲染出 crumbs/entries、回退说明可见；
- 浏览器选中当前目录后调用 `addAllowed(path, family)`；
- 读框里 write 行无可用 ✕；写框里 write 行有 ✕；
- 目录行尾 `/`（既有断言保留）。

**check-gate.mjs**
- 写⇒读：`add-write /tmp/ap-write/x` ⇒ `workspace-access` 读 `/tmp/ap-write/x` 放行且不弹窗；`remove-write` 后读重新询问；`remove-read` 对 write 行返回提示且状态不变；
- `normalizeUserPath` 单测（functions.js 直测）：`"/etc/hosts"`、`'"/etc/hosts"'`、`` `~/x` ``、`~/.config`、`$HOME/x`、`file:///etc/hosts`、`/tmp//a/./b/../c`、`./a`（root 解析）、尾斜杠、空串、`~user`、`\0`、无 root；
- `add` 路径不存在（读侧）⇒ `kind:'error'`；`add-write` 不存在 ⇒ 允许并提示；
- 授权页“总是修改”后同一目录的读不再弹窗（闸门读侧 `grantedBy`）。

**check-locale.mjs**：新 DICT 键 zh/en 齐全，无键名渲染。
**check-menu.mjs**：加号菜单项仍可打开；菜单动作触发浏览器请求（事件被面板接收）。
**check-visual.mjs / check-seat.mjs**：回归（不受影响）。

负向对照：① 去掉 pick 回退 ⇒ check-panel 红；② `effectiveRead` 恒 false ⇒ check-gate 写⇒读断言红；③ `normalizeUserPath` 直通 ⇒ 单测红。每个对照跑完按 md5 还原。

## 5. 决策点（请确认）

1. **读框里的写行怎么撤销读？** 建议：读框不提供 ✕（读由写隐含），撤销走写框（移除写；若同时有显式读，则保留读）。
2. **选择器行为**：建议先试系统对话框、失败回退内置浏览器；也可反向（总是内置浏览）。
3. **读侧是否允许添加“尚不存在”的路径？** 建议读侧拒绝、写侧允许（并标注“将按文件处理”）。
4. **相对路径按工作区根解析？** 建议是（`./a`、`a/b` 都相对工作区根）。

## 6. 实施顺序

1. `functions.js`：`normalizeUserPath` + 单测（纯函数先落地）。
2. `index.js`：写⇒读（`effectiveRead`、`readable`、命令语义）+ `add`/`add-write` 规范化与 `stat`。
3. `client.js`：`DirectoryBrowser` + 回退 + 读框语义 + DICT。
4. 六套测试改造 + 三个负向对照。
5. `README.md` 更新、`FIX-PLAN-2.md` 补实施状态、重启 Harness 真机验收（browse 回退浏览器、写⇒读、`~`/引号/`file://` 输入）。

## 7. 实施状态（2026-10-31 完成）

四个决策点按用户答复落地：**读框 ✕ 同时撤销读+写**；**先试系统对话框、失败回退内置浏览器**；**不存在的路径两侧都允许但提示**；**相对路径按工作区根解析**（与 §5 的草案不同，以用户答复为准）。

| 项 | 状态 | 落点 |
|---|---|---|
| 目录选择器 | 完成 | `client.js` `chooseDirectory()`：先 `props.pickDirectory()`，取消（null）直接返回，失败/异常开内置浏览器；加号菜单失败改 `requestBrowser()`；`DirectoryBrowser` 渲染 breadcrumbs/子目录/空态/truncated/失败行 |
| 写⇒读 | 完成 | `index.js` `extraRowsOf` 的 `readable = read \|\| write`；`grantedPathsOf` 读侧用 `readable`；`allowMarker` 的 `r` 位；读框过滤 `readable`；`add-write` 文案写“读+写” |
| 路径识别 | 完成 | `functions.js` `normalizeUserPath`；`index.js` `typedPathOf`（`statSync`/`realpathSync`）、`PATH_ERRORS`；命令级“已识别为 …”“当前不存在…”提示 |
| 撤销语义 | 完成 | `remove-read` 在可写行上整行移除（`impliedRead`）；`remove-write` 只撤写；读框 write 行的 ✕ 有 `removeImpliedRead` 提示 |
| 目录行合并 | 完成 | `canonicalPath`：allowlist 的 `/x/` 与授权的 `/x` 合并为一行，remove 两侧按规范形式匹配 |
| 文案 | 完成 | DICT 新增 `pickFallback`/`browse*`/`removeImpliedRead` 共 10 键（zh+en）；`allowHint` 改写 |
| 文档 | 完成 | README「The control」「The authorization dialog」「Command」三处 |
| 测试 | 完成 | 六套全绿；`check-gate` 210 项 |
| 真机验收 | 待重启 | 宿主侧改动需重启 Harness 后生效 |

测试与对照：

- `check-gate`：210 项。新增 `normalizeUserPath` 直测 24 项（引号四种、转义空格、`~`/`$HOME`/`${HOME}`/`~user`、`file://`+percent、相对/`..`/折叠/尾斜杠/空串/`\0`/Windows 盘符与 UNC），命令级 18 项（引号、单引号、`file://`、`~`、相对、折叠、已存在目录、不存在路径提示、`~root` 拒绝、空参数），以及写⇒读与 `remove-read`/`remove-write` 矩阵。
- `check-panel`：读框按 `readable` 列出可写行、写框只列可写行、write 行的 ✕ 标题、浏览器渲染（标题/当前目录/子目录/上一级/选择/回退说明）、`requestBrowser` 回退接线、`listDirectory` 注入。
- 负向对照三个（全部生效，跑完按 md5 还原）：① `typedPathOf` 直通 ⇒ 5 项红；② `readable` 只取 `read` ⇒ 2 项红（`add-write also grants reads`、`the implied read opens no dialog`）；③ 去掉 pick 回退 ⇒ 1 项红（`the in-app browser is offered when the system dialog is missing`）。

文件指纹（实施后）：`client.js` `5c6c268f0c1a9a2f1ffd66938a433f27`、`index.js` `d6bd31e17f8ec823388ad806be023a53`、`functions.js` `2e8c8b2f9c1acdcc65a67cb6ac6c7ee9`；`cordis.patch.yml` 未改（`d5cfb3e6ec3ae11ada8adc3fc39d6af9`）。

真机验收清单（重启后逐条过）：① 面板「选择目录…」在无 zenity 的机器上开出内置浏览器并能进入子目录、选目录后成行；② 写框 `add-write` 后读框立刻出现同一行；③ 输入 `"~/x"`、`file:///tmp/a`、`./rel`、`/tmp/a/../b`、`~root/x` 得到规范路径/明确拒绝；④ `remove-write` 后读仍放行、`remove-read` 后读写都重新询问；⑤ 加号菜单「允许访问的文件或目录」在 pick 失败时同样开出内置浏览器。

### 7.1 真机复测追加修复（2026-10-31，参数个数）

真机上「选择目录…」仍然报错；根因不在渲染，也不在 pick 失败的接线，而在**远程调用的参数个数**：

- `client.js` 的 `listDirectory(null)` 走了 `ctx.remote.directoryPicker.list()`（零个业务参数）。typert 生成的客户端按声明校验参数个数，直接抛 `client api: directoryPicker/list expected 1 business argument(s) plus an optional AbortSignal, got 0`；`listDirectory` 的 catch 把它转成 `{ failure }`，内置浏览器因此一打开就显示错误行。
- 修复：`listDirectory` 始终显式传一个业务参数——`list(typeof path === 'string' && path !== '' ? path : undefined)`；后端把 `undefined` 当默认值（主目录）。实测 `list(undefined)` 返回 `{ path: '~', home: '~', crumbs: 3, entries: 14, truncated: false }`。
- 验证方式：临时 occupant（slot `conversation.input.right`，order 950）在真实页面里跑 `pick()`/`list()`，把结果编码进 `/access-allow list DIAG …` 的参数；该命令的 `command/run` 会原样写进会话日志，据此读出结果（命令本身仍 success，因为 `list` 分支忽略多余参数）。临时探针已移除。
- 测试：`check-panel.mjs` 的假 `directoryPicker.list` 现在按参数个数抛错（复刻生成客户端的校验），并新增三条断言（默认目录、显式目录、源码不得出现空参调用）。负向对照：把修复回退成 `list()` 跑出正好 3 FAIL（含真实错误文本）。
- 该修复只在浏览器半边，HMR 已热更新到页面，无需重启 Harness；当前 `client.js` md5 `7b21504fc33c078fc3aa2a4e50f17335`（`index.js`/`functions.js` 未变）。

### 7.2 真机复测追加修复（2026-10-31，「点选择目录后整块区域消失」）

修复 §7.1 之后用户复测：「点选择目录，整个额外可读写文件区直接消失」。真机取证显示不是崩溃退出，而是**渲染异常被宿主的 slot 级错误边界吞掉**：

- 探针在真实页面里点开面板、点「选择目录…」，同时拦截 `console.error`/`console.warn`（边界捕获的渲染异常不会派发 window `error` 事件）。抓到的原文是
  `TypeError: Cannot read properties of undefined (reading 'bottom')  at AllowControl (client.js:773)`，紧跟 `slot entry crashed in 'conversation.input.right': …`。
- 根因：内置浏览器打开时用「触发器位置」当锚点（`browse.anchor`，决定 `bottom`/`left`）。`loadListing()` 的成功分支用**新对象**覆盖 `browse` 状态（只带 `family/listing/busy/failure/note`），把 `anchor` 丢掉了；等目录列表异步返回后再渲染，`browse.anchor.bottom` 抛 TypeError，错误边界把整个 composer 控件卸载 ⇒ 看起来就是“区域消失”，界面上也不会冒出错误提示。
- 修复：成功分支改成函数式合并 `setBrowse((state) => state === null ? state : ({ ...state, family, listing, busy:false, failure, note:null }))`，锚点与打开时的布局一起保留；用户中途关掉浏览器（state 变 `null`）也不会被迟到的列表结果重新拉起来。
- 测试：`check-panel.mjs` 新增 4 条**点击链路**断言（面板打开时存在「选择目录…」按钮；`pickDirectory` 抛能力错误后异步刷新不得崩溃；刷新后浏览器列出默认目录的子项；控件触发器仍挂载）。负向对照：把该分支改回“整体替换”跑出 3 FAIL，报错正是真机里的 `Cannot read properties of undefined (reading 'bottom')`。
- 修复仅在浏览器半边，HMR 已热更新，无需重启 Harness。当前 `client.js` md5 `8a5a8b28b29a147dae9e5ffbc36342bd`（`index.js` `d6bd31e17f8ec823388ad806be023a53`、`functions.js` `2e8c8b2f9c1acdcc65a67cb6ac6c7ee9` 未变）。六套自检：locale 7 / panel 37 / menu 36 / visual 67 / gate 210 / seat 21，全绿。临时探针已从 `client.js` 移除（`grep selfcheck|DIAG` 无残留）。

### 7.3 追加需求：目录浏览器可选 WSL 之外的盘（2026-10-31）

用户复测通过后提出：「这下好了，但是只能选择wsl里的内容，我希望是点了wsl和windows还有其他盘里的内容都可以选」。

- 事实：WSL 把 Windows 盘挂在 `/mnt/<盘符>`（本机 `/mnt/c`、`/mnt/d`、`/mnt/e`，另外 `/mnt/wsl`、`/mnt/wslg` 是 WSL 内部目录）；宿主 browse 后端是整盘范围、只列目录，所以这些盘本来就能逐级浏览，只是要先从主目录一路“上一级”走到 `/` 再进 `/mnt`，实际上没人会这么点。
- 实现（纯浏览器半，无宿主改动）：
  - 浏览器打开时读一次 `/mnt`（`loadPlaces()`），把**单个字母**的子目录当作盘符（`c` → 标签 `C:`，路径 `/mnt/c`），`wsl`/`wslg` 这类内部目录过滤掉；读失败就只是没有盘符行，面包屑仍可用。
  - 在标题与面包屑之间加「快捷位置」一行：`主目录`（来自 listing 的 `home`）、`WSL 根目录`（`/`）、每个盘符一个 chip；点击直接 `loadListing(family, path)`，当前路径的 chip 变淡。
  - 新 locale 键 `browsePlaces`、`browseWslRoot`（zh/en 齐全）。
- 测试：`check-panel.mjs` 的假 `list` 改为按路径返回（`/mnt` 返回 c/d/e 与 wsl/wslg），点击链路新增 4 条断言：快捷位置行存在、C:/D: 都在、`/mnt` 内部目录不当盘符、chip 的 onClick 接到 `loadListing`。负向对照：删掉整行 ⇒ 3 FAIL；去掉单字母过滤 ⇒ 1 FAIL（`/mnt` 内部目录被当盘符）。
- 真机验证（临时 occupant 探针，事后已移除）：宿主 `list('/mnt')` 返回 `["c","d","e","wsl","wslg"]`，`list('/mnt/c')` 返回 15 个子目录；页面上的「选择目录」对话框里出现 chip：`主目录`、`WSL 根目录`、`C:`、`D:`、`E:`，title 分别是 `~`、`/`、`/mnt/c`、`/mnt/d`、`/mnt/e`。
- 当前指纹：`client.js` `fd2e26a9df80c4de3f4a7f8200388cd9`（`index.js`/`functions.js` 仍未变，客户端改动靠 HMR 生效，无需重启）。六套自检：locale 7 / panel 41 / menu 36 / visual 67 / gate 210 / seat 21，全绿。
- 备注：手动输入框目前不会把 `C:\Users\…` 自动映射成 `/mnt/c/Users/…`；如果要把这种写法也识别成真实路径，需要改宿主半的 `normalizeUserPath`（要重启一次 Harness），本次未做。

### 7.4 追加需求：手动输入 Windows 盘符路径（2026-10-31）

用户 m05492「需要，先改」= 同意手动输入框接受 `C:\Users\...` 并映射到 WSL 挂载路径。

- 宿主半（改后需重启 Harness 才生效）：
  - `functions.js` 的 `normalizeUserPath` 新增 `options.windowsMounts`（盘符大写 → 挂载点）。在引号剥离/反转义/`file://` 处理之后、Win/Linux 归一化之前，把 `^([A-Za-z]):(.*)$` 改写成挂载点下的 posix 路径：`\` 与 `/` 都当分隔符，折叠 `.`/`..`/空段，`C:` 与 `C:\` 视为目录；返回值新增 `mapped: true`。不传映射表、或 `options.windows === true`（原生 Windows）时行为完全不变；UNC（`\\server\share`）不当作盘符。
  - `index.js` 新增模块级 `windowsMounts()`：读 `/proc/mounts`，把源形如 `^([A-Za-z]):\134$`（WSL 的 9p 挂载，反斜杠按八进制转义）且目标是绝对路径的条目记成 `C → /mnt/c`；读不到（非 Linux / 非 WSL）返回空表。`typedPathOf` 把它传给 `normalizeUserPath` 并回传 `mapped`；`add`/`add-write` 成功文案在映射时附「；Windows 盘符路径已映射到该 WSL 路径」；`/access-allow` 帮助增一行说明。
  - 客户端（HMR 即时生效）：手动输入框 placeholder 增补「Windows 盘符写法如 C:\Users\me 也可」。
- 测试（`check-gate.mjs` 从 210 项增至 **228 项**）：
  - 13 条 `normalizeUserPath` 直测：`C:\Users\me` → `/mnt/c/Users/me` 且 `mapped: true`、盘符大小写、裸盘符 `D:` → `/mnt/d`（目录）、目录尾斜杠、`C:\a\..\b` 折叠、引号内带空格路径、`file:///C:/x`、未挂载的 `Z:\nope` 保持原样、UNC 不映射、无挂载表保持原样、`windows: true` 不映射。
  - 5 条命令级：测试自己从真实 `/proc/mounts` 取一个已挂载盘符（本机 C/D/E），`add "C:\ap-win-test\"` ⇒ 列表出现 `/mnt/c/ap-win-test/`、回执含「Windows 盘符」；`add-write` 同样落成挂载点路径。没有挂载盘符的机器走 else 分支断言不映射。
  - 负向对照（在 `/tmp` 副本上跑，插件本体未动）：① 映射段短路 ⇒ **11 FAIL**；② `typedPathOf` 不传 `windowsMounts` ⇒ **3 FAIL**（命令级三条）。
- 指纹：`client.js 54fff30de33ee0ba8970d8f3168105d1`、`index.js 1dfc7895c49db485ceb0676f223a4353`、`functions.js 0ca9089e4175a53277f95d8245dbe2f9`；六套全绿（locale 7 / panel 41 / menu 36 / visual 67 / gate 228 / seat 21）。
- 生效条件：客户端半靠 HMR；宿主半必须重启 Harness。重启后用临时页面探针跑 `/access-allow add "C:\Users"` 验证落成 `/mnt/c/Users`、再 `remove` 复原。

**7.4 真机验收与 remove 侧补丁（2026-10-31 晚）**

- 用户重启 Harness 后（新 pid 5639，启动 17:53:47，晚于宿主文件 mtime），用临时页面探针（occupant `access-permission-selfcheck`，走 `/access-allow list DIAG …` 落盘）实测：`add "C:\Users"` ⇒ `已识别为 /mnt/c/Users/（目录；Windows 盘符路径已映射到该 WSL 路径）…`，列表出现行 `1. /mnt/c/Users/（读）`、标记 `[allow: %2Fmnt%2Fc%2FUsers%2F|rd]`、帮助含盘符说明行；随后 `remove /mnt/c/Users/` 复原为 0 项。⇒ 映射端到端成立。
- 验证中发现的不对称：`add` 会读取引号/`~`/盘符写法，而 `remove*` 只做 `canonicalPath(argument)`，所以 `remove "/mnt/c/Users/"`（带引号）报「列表中不存在」。已修：`index.js` 的 remove 分支改为 `const typed = typedPathOf(argument, workspaceRoot(session)); const wanted = canonicalPath(typed.path === '' ? argument : typed.path)`——与 `add` 同一读取器，识别不了时回退原始文本（旧行仍可删）。
- 测试：`check-gate.mjs` 增至 **237 项**，新增 9 条 remove 侧断言（引号路径 add→remove→列表消失；`~` 路径同理；已挂载盘符路径同理，未挂载机器跳过）。负向对照：把 remove 分支改回 `canonicalPath(argument)` ⇒ **6 FAIL**（正好是三条 remove + 三条列表消失）；插件本体未动。
- 六套自检全绿：locale 7 / panel 41 / menu 36 / visual 67 / gate 237 / seat 21。
- 指纹：`client.js 54fff30de33ee0ba8970d8f3168105d1`、`index.js 9cedbd3ec329b2d22a670e849f4ce03a`、`functions.js 0ca9089e4175a53277f95d8245dbe2f9`。remove 侧补丁属宿主半，需再重启一次 Harness 才生效；客户端改动（placeholder）已在跑。
