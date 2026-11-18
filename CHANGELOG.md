# Changelog

公开仓库：<https://github.com/kerzeftu/dsh-readwrite-gate>（MIT）。

## 1.4.1 — 2026-11-19

### Fixed
- 修复子 shell、命令替换和括号组里切换的目录、设置的变量影响外层命令的问题。
- 修复条件命令不区分 `cd` 成败的问题：`&&` 只看成功后的命令，`||` 使用原目录，分号或换行接续时两种目录都检查。
- 修复管道两侧互相传递目录的问题。
- 修复 Python heredoc 的路径不按解释器调用目录解析的问题，包括 `cd … && python3 …` 写在同一行的情况。

### Changed
- 调整脚本判定：内联脚本运行中切换目录，或从环境变量、标准输入、路径拼接取得目标时，受限档位说明无法确定访问目标并拒绝，不再按脚本启动目录放行，也不再请求针对猜测目录的授权。命令中能读到的绝对路径仍照常判定。
- 调整写法要求：依赖“换行开头、上一行 `cd` 一定成功”的命令需改用 `&&` 连接。

### Added
- 新增授权提示中的触发原因、判定路径、工作区和相对路径起始基准；无法完整识别命令目标时，说明实际范围不止列出的路径。

## 1.4.0 — 2026-11-15

### Changed
- 路径判定改为“先归形态、再折叠”的单一模型（`classifyPathForm` / `foldPath`）。共享根以
  `server\share` 为锚，`..` 不能退到共享之外；盘符路径最多退到盘根；带锚点的相对 Windows 路径
  借基准路径的盘符或共享根补齐。
- `file:` URL 只有一个解码入口（`fileUrlPath`）：支持 `file:///C:/…`、`file://server/share/…`、
  `localhost` 与百分号转义。手动输入路径复用同一入口，面板与闸门不再可能给出两种路径。

### Fixed
- POSIX 上反斜杠不再被当分隔符：`/etc\passwd` 不会被读成 `/etc/passwd`，`/home/user/a\b` 仍是一层目录。
- 设备路径（`\\?\C:\x`、`\\.\PhysicalDrive0`）与盘符相对路径（`C:work`）不再被当成普通相对路径，
  统一拒绝并给出原因（`device-path` / `drive-relative`）。
- 临时区在原生 Windows 上只认 `os.tmpdir()`，不再因为字面量 `/tmp` 而放行一个不存在的位置。
- `canonicalPathOf` 的父目录回退同时认 `/` 与 `\`；缓存加 2 秒过期，链接改指后不会一直用旧答案。

### Added
- `test/check-paths.mjs`：跨平台的纯词法路径用例（形态、文件 URL、折叠、包含、拒绝原因、POSIX 反斜杠），
  已加入 `npm test`。

## 1.3.1 — 2026-11-15

### Fixed
- 授予目录后「额外可读写文件」的计数不再等到点开面板才更新。此前的刷新只依赖 `userQuestions`
  投影，而该投影从 `tool/call` 与 `tool/result` 折叠——插件的授权页走的是问答服务直调，
  不产生这两个事件，计数因此停在旧值。现在改为订阅会话状态：授权页是 pending interaction，
  应答后该标记消失即重读列表，回合由运行转结束时也重读；读取有节流，其余状态变化不触发。
  不新增定时器，空闲时没有请求，也不会往会话日志写事件。

### Changed
- 客户端注入增加 `uiSession`（只读取 `sessionStatus`），`conversation.input.right` 的注入项增加
  `statusStore`。

### Docs
- `docs/build-refresh-and-portability.md` 增加实施记录：为什么否决周期读取（命令执行会写
  `command/run`/`command/done`）与为什么不能自建推送事件，以及阶段一最终采用的边沿触发方案。

## 1.3.0 — 2026-11-15

### Added
- `LICENSE`：MIT。`package.json` 补 `license`、`engines.node >= 22`、`keywords`，`files` 收录 `LICENSE`。
- 文档中的本机绝对路径全部替换为占位符（`<repo-path>`、`<profile-dir>`、`<dsh-dir>`、`~`），
  测试夹具路径改为与具体机器无关的形式。
- README/配置文档标明已测试版本：DSH `0.2.1-alpha.1`（主力）与 `0.2.2-rc.3`（组合配置+启动验证）。

### Changed
- 插件改用正式名 `dsh-readwrite-gate`（显示名「司门」）：`package.json` 的 `name`、
  `cordis.patch.yml` 的 `- id: readwrite-gate`、客户端模块 id、日志前缀、授权页问题 id、
  座位注册名与 `conversation.input.right` 控件 id 一并更新。**改客户端模块 id 必须重启
  Harness**——只刷新页面会让宿主注册表仍按旧 id 查找，客户端半静默不注册、界面回退到
  宿主自带控件（新增两档因此没有图标）。
- 六套自检从开发目录迁入 `test/`：路径由 `import.meta.url` 推出，夹具改用仓库内 `test/fixtures/`
  （已进 `.gitignore`），宿主相关用例可用 `AP_DSH_DIR` 指定 checkout、缺失时自动跳过；新增
  `test/run-all.mjs` 与 `npm test` 一次跑完七套。`LICENSE` 署名改为 `kerzeftu`，`package.json` 补 `author`。

### Fixed
- `isUrlLike()` 把 `file://…` 也当远程地址，导致 `curl file:///etc/passwd` 这类本地读取在判定里“不涉及路径”；
  现在 `file://` 归为本地路径，只有其他 scheme 才算地址。随包 `test/delegation.test.mjs` 的对应断言同步更新
  （此前该断言锁的是旧行为，跑 `node test/delegation.test.mjs` 会失败）。

### Docs
- 新增 `docs/`：总览、架构、档位与范围、路径判定、授权、界面、配置、开发、测试、排障十份职能文档，
  外加六条设计决策（ADR）与历史归档；`docs/README.md` 是文档地图。
- 根 `README.md` 改为入口：五档表、安装、`/access-allow` 速查、文档索引、已知边界。
- 早期方案草稿移入 `docs/history/`，拆分前的 README 快照一并留档。
- `package.json` 的 `files` 增加 `CHANGELOG.md` 与 `docs`。

## 1.2.0 — 2026-11-15

### Added
- 「工作区内读写」（preset `workspace-access`）与「工作区内编辑」（preset `workspace-write`）两档改名，图标互换；`/tmp` 与 `os.tmpdir()` 默认视为内部路径（平台沙箱本来就允许写），不再逐次弹授权页。
- 权限菜单与「切换到完全访问」确认弹窗改用宿主原版材质（`--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter`、`--dsw-elevation-prominent`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-mask-1`），确认弹窗补齐焦点环、Esc、遮罩点击、原版感叹号与按钮规格。

### Fixed（发布前 review 的修复）
- 路径识别：裸文件名（`cat secret`）按路径处理；前置赋值（`X=/etc/passwd; cat "$X"`）、`dd if=`、`curl file:///…` 计入读；`cp src dst` 只把最后一个操作数当目标；选项值（`-n`、`--max-count` 等）不再被当路径。
- 工具调用：`glob {}`/`grep {pattern}` 缺省搜索目录即工作区根；`present { files: [{ path }] }` 等嵌套路径会被提取；空路径的读调用不再直接放行。
- 相对路径不再被 `/tmp` 吸收：先按请求的 `workdir`/`cwd` 定位成绝对路径，再判定临时区与工作区；路径做 `realpath` 折叠，工作区内软链指向区外时按区外处理；POSIX 下反斜杠不再当分隔符。
- 授权等待期间把级别降到「无权限」（或把该族收窄）时，回答「仅一次」也不再放行。
- 删除只读授权不再抛 `TypeError: Cannot set properties of undefined (setting 'write')`。
- 客户端：projection 迟到不再改变 hook 数量；入口补注入 `sessions`（真实注入约束下曾把加号菜单入口隐藏）；目录浏览器与列表刷新用请求代次丢弃过期响应（旧写请求曾把"添加读取"变成"添加修改"）；resize 监听在关闭时移除。
- 授权改为纯内存的对话态（弹窗走问题服务、答案不进工具日志，日志回放本就无法复现）：`agent/disposed` 不再清缓存，派发的子会话继承父会话的授权。

## 1.1.0 — 2026-11-01

### Added
- **Delegated sessions**（`README.md` → Delegated sessions）：子会话级别沿 `header.parentSession` 向上继承最近祖先；祖先的 standing grants 一并折叠；首行 `<!-- dsh-access-scope: {"write":[…]} -->` 支持逐任务写切片，越界以 `[access: 越界写入]` 拒绝、不弹框。
- 只认 `user/message` 上的标记：assistant 消息或工具输出里引用的同名注释不构成声明。
- 不透明命令按自身 `cd` 到达的目录判定（`opaqueBases`），而不是一律按会话根。
- `test/delegation.test.mjs`：继承、前缀攻击、切片内/外写、越界读授权框、伪造标记、`cd` 判定、URL、箭头函数、fd 复制等用例。

### Fixed
- `file:///…` 等 URL 字面量被误当路径（可能触发授权框或记为写目标）。
- `() => 1` 的 `>` 被误读成重定向。
- `cmd 2>&1` 的 `>&` 未处理：tokenizer 拆出的 `1` 成为新命令 → `unknown-executable` → 命令变 opaque → 在会话根被误判越界写。
- `2>/dev/null`、`>&2` 不再产生写目标。

### Changed
- 开发期草稿 `FIX-PLAN*.md` 移入 `docs/`。
- `files` 补 `README.md`、`test/delegation.test.mjs`。
