# 设计决策（ADR）

每条决策记五件事：背景、决策、后果、替代方案、什么时候该重新考虑。
编号不复用；推翻一条就新增一条，并在旧的那条顶上标记“已被 00XX 取代”。

| 编号 | 决策 | 状态 |
|------|------|------|
| [0001](0001-take-over-permission-seat.md) | 接管宿主权限控件座位（`priority: -1`），不新增第二个控件 | 生效 |
| [0002](0002-paths-not-heuristics.md) | 按真实路径判定，不用命令形态启发式 | 生效 |
| [0003](0003-conversation-scoped-grants.md) | 授权是对话内内存态，不落日志、不跨重启 | 生效 |
| [0004](0004-per-path-authorization.md) | 「总是」记本次请求的路径（目录覆盖其下），不记“族”级布尔 | 生效 |
| [0005](0005-temp-area-inside.md) | `/tmp` 与 `os.tmpdir()` 视为内部区域 | 生效 |
| [0006](0006-preset-table-replaced.md) | 预设表整体替换而非合并，级别表用 `preset` 双向绑定 | 生效 |
