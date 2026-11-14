# 界面：控件、面板、弹窗

浏览器文件是 `client.js`，通过 `window.__ModuleLoader__.load({ id, factory(require) })` 装配。
它**不** require 任何宿主 Client 包，样式只用宿主主题 token，所以能跨版本工作。

## 座位：为什么必须 `priority: -1`

`conversation.input.permission` 是 `kind: 'single'` 的座位：同一优先级只能有一个注册者，重复注册会抛错，
而错误发生在 inject 的延迟路径里，表现是“什么都没变”——接管静默失败。

宿主自带的权限控件占着 priority 0，且它的图标表硬编码只有三档（`read-only`/`workspace-write`/`danger-full-access`），
我们新增的两档没有图标。所以本插件用 `priority: -1` 覆盖它（低优先级渲染），并自己画五档的符号、颜色与字体。

改这里之前先看 `docs/decisions/0001-take-over-permission-seat.md`；测试 `check-seat.mjs` 复刻了座位规则，删掉 `priority` 会红。

## 三个注册点

| 座位 / 扩展点 | id | 关键参数 | 作用 |
|---------------|----|----------|------|
| `conversation.input.permission` | — | `priority: -1` | 替换宿主的权限控件 |
| `conversation.input.right` | `access-permission-files` | `order: 10` | 「额外可读写文件」控件，排在权限控件右侧 |
| `commandUi` | `extra-readable-files` | `available()` 返回布尔 | 加号菜单里的入口；`name` 必须 ASCII |

`available()` 里**不能抛错**：加号菜单在合成候选时调用它，抛一次就让整个 `+` 菜单打不开（历史上出过）。
同理 `inject` 里声明了 `sessions`，因为菜单入口要读 `ctx.sessions.binding()`；漏声明会在真实注入约束下直接抛。

## 控件外观

- 几何与宿主原控件一致：`font-size: 13px`、`font-weight: 500`、高 28px、`gap: 4px`、`padding: 0 4px 0 8px`。
- 每档一个强调色（`MODES[value].accent`），名字与颜色取同一个 `option.value`，不会错行。
- 「额外可读写文件」用 Windows 风格的实心双色文件夹图标（`#e8a33c` / `#ffc94c`）+ 次级文字的计数。

配色总表（`MODES`）：

| 档 | 颜色变量 | 说明 |
|----|----------|------|
| 无权限 | `--dsw-alias-state-success-primary` | 绿 |
| 工作区内读写 | `--dsw-alias-brand-primary` | 品牌色（深色主题下近白） |
| 只读 | `--ap-level-read` | 荧光黄：暗色 `#eeff00`、浅色 `#7a8a00` |
| 工作区内编辑 | `--ap-level-write` | 浅黄：暗色 `#f5e3a3`、浅色 `#c9a227` |
| 完全访问 | `--dsw-alias-state-error-primary` | 红 |

宿主主题没有黄系 alias，所以 `--ap-level-read` / `--ap-level-write` 由插件自己注入：
`installLevelPalette()` 往 `<head>` 写一个 `<style data-plugin-css="dsh-access-permission-level-palette">`，
内容形如 `body{…}body[data-ds-dark-theme]{…}`（与宿主 `ThemePresenter` 同一套切换机制），消费者带 hex 兜底。

**注意 `var(--x, fallback)` 的语义**：变量“未定义”才用兜底；变量“定义了但不是合法颜色”会让整条声明在计算值阶段失效，颜色回退成**继承值**（深色主题下是近白）。历史上一次“颜色反了”的排查就是因为这个。

## 菜单

- 五行一档，选中行用 `--dsw-alias-interactive-bg-hover` 底色，不画不透明白块。
- 材质取宿主原版菜单：`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)` + `--dsw-elevation-prominent`。
  早期用 `--dsw-alias-bg-overlay` 画底（浅色 `#e9ecf2`），看起来发灰，被用户点名改回。
- 浮动层用 `ReactDOM.createPortal` + 文档级 capture `pointerdown` 关闭，不要用全屏 overlay（会像页面卡死）。

## 「额外可读写文件」面板

分上下两框：读在上、写在下，各自计数、空态、✕，各自一对「选择目录… / 手动输入路径」按钮。

- 每行显示绝对路径（`title` 悬停看全路径，长路径省略号）+ 族标记（读 / 写 / 读写）+ ✕。
- 数据来源：宿主 `/access-allow list` 输出里的 `[allow: …]` 标记，字段以 `\x01` 分隔，形如 `percentEncodedPath|flags`，
  flags 是 `r`/`w`/`rw` 再拼 `d`（目录）。无竖线的旧字段按只读处理。
- 目录浏览器是内置回退：宿主 `directoryPicker` 在本机只有 `browse` 能力（没有 zenity/kdialog），
  `pick` 必失败，所以先试原生、失败回退到内置浏览器；盘符快捷入口读 `/mnt` 单字母目录。
- 手动输入走 `normalizeUserPath`：剥引号、`~`/`$HOME`、`file://`、相对路径按工作区根、`..`、Windows 盘符映射。

状态更新的两个坑（都已修，改这里别退回去）：

1. **请求代次**：目录浏览与列表刷新各自持有 `listingTicket` / `refreshTicket`，过期响应直接丢弃。
   否则“先发的写目录请求晚到”会把 family 改回写，用户以为在读框选目录，实际授的是写。
2. **hook 顺序**：`if (currentValue === undefined) return null` 必须放在所有 hook 之后。
   projection 从 `undefined` 变有效时 hook 数量变化会让 React 抛错。

## 完全访问确认弹窗

点「完全访问」时先弹一次风险确认（勾选“我已了解风险，并愿意继续”才能继续）。它复刻宿主 `RiskConfirmation`：

- 遮罩 `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`，卡片 `--dsw-alias-bg-layer-2`，层级 `z-index: 1000`。
- 圆圈感叹号图标、`Esc` 关闭、遮罩 `onClick` 关闭、初始焦点在复选框、`Tab` 循环、关闭后焦点还给触发按钮。
- 按钮规格：取消 `outline` 最小宽 72、确认 `primary` 最小宽 136，高 36px。

## 本地化

- 界面文案在 `client.js` 内的 zh/en 字典（`DICT`）里；`locale/zh.json`、`locale/en.json` 只有 manifest 字段（`meta`）。
- 缺键**不报错**，直接把键名渲染出来——加文案时两份字典要一起加。
- 宿主命令的描述在 `index.js` 里，是另一套（不经浏览器字典）。

## 让改动生效

`client.js` 改动由 `dsh-client-hmr` 轮询 mtime/ctime/size 重新发布，刷新页面即可看到；
`index.js` / `functions.js` / `cordis.patch.yml` 属宿主半，必须重启 Harness。
详见 [development.md](development.md)。
