# 文档地图

这份目录按“你想回答什么问题”拆分，不按文件类型拆分。第一次接触请按 1 → 2 → 3 读。

| # | 文档 | 回答什么问题 | 主要读者 |
|---|------|--------------|----------|
| 1 | [overview.md](overview.md) | 这是什么插件、解决什么问题、五个权限档各是什么、术语怎么理解 | 所有人 |
| 2 | [architecture.md](architecture.md) | 一次文件操作从工具调用到被放行/拒绝，中间经过哪些组件、哪些状态 | 要改代码的人 |
| 3 | [configuration.md](configuration.md) | 怎么安装、预设表和插件配置每个字段是什么、`/access-allow` 怎么用 | 部署/使用的人 |
| 4 | [levels-and-scopes.md](levels-and-scopes.md) | 五档与 `readScope`/`writeScope` 的对应关系，平台沙箱和插件各管哪一半 | 调权限语义的人 |
| 5 | [path-analysis.md](path-analysis.md) | 怎么从一个工具调用或一条 shell 命令里判断“读了什么、写了什么、在不在工作区” | 改判定规则的人 |
| 6 | [authorization.md](authorization.md) | 授权页什么时候弹、三个选项各记什么、授权存哪里、什么时候失效 | 改授权逻辑的人 |
| 7 | [ui.md](ui.md) | 输入框里的权限控件、额外路径面板、确认弹窗、座位与主题约束 | 改界面的人 |
| 8 | [development.md](development.md) | 本地怎么改、怎么让改动生效（热更新/重启）、怎么调试 | 维护者 |
| 9 | [testing.md](testing.md) | 六套自检各测什么、怎么加断言、负向对照的纪律 | 维护者 |
| 10 | [troubleshooting.md](troubleshooting.md) | 改完之后没生效/样式不对/菜单打不开，按症状查 | 维护者 |
| 11 | [decisions/](decisions/) | 关键设计决策的记录（ADR）：为什么这样选 | 想知道“为什么”的人 |
| 12 | [history/](history/) | 早期方案草稿与拆分文档前的 README 快照，仅供追溯 | — |

根目录的 [README.md](../README.md) 只做入口：一段介绍、五档表、安装、命令速查。
变更记录在 [CHANGELOG.md](../CHANGELOG.md)。

约定：

占位符：`<repo-path>` 是本仓库的绝对路径，`<profile-dir>` 是 Harness profile 目录，
`<dsh-dir>` 是某个 DSH 版本目录，`<selftest-dir>` 是开发期自检脚本目录（不在仓库内）；`~` 指当前用户主目录。


- 文档里出现的路径都相对仓库根目录；`index.js` / `functions.js` / `client.js` / `cordis.patch.yml` 指仓库根下的同名文件。
- 代码行号会漂移，因此正文只引用函数名和文件；需要精确位置时用 `grep`。
- 图表一律用 ASCII，不引入图片依赖。
