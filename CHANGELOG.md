# Changelog

内部使用（`private`），不对外分发。

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
