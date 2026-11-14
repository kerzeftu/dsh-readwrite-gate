# Changelog

内部使用（`private`），不对外分发。

## Unreleased

### Added
- `LICENSE`：MIT。`package.json` 补 `license`、`engines.node >= 22`、`keywords`，`files` 收录 `LICENSE`。
- 文档中的本机绝对路径全部替换为占位符（`<repo-path>`、`<profile-dir>`、`<dsh-dir>`、`<selftest-dir>`、`~`），
  测试夹具路径改为与具体机器无关的形式。
- README/配置文档标明已测试版本：DSH `0.2.1-alpha.1`（主力）与 `0.2.2-rc.3`（组合配置+启动验证）。

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
