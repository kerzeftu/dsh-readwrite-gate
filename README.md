# Access permission levels

DSH（DeepSeek Harness）的一个 Cordis bundle：**新增**两个权限档（无权限、工作区内读写），
并让每一次文件操作都先经过“级别 → 范围 → 授权”的判定；工作区之外的操作会停下来问用户，**读和写分开授权**。

```text
模型要用文件
   │
   ├── 在范围内 ────────────────► 放行（写入仍受平台沙箱约束）
   ├── 在范围外，本对话已授权 ──► 放行
   └── 在范围外，未授权 ────────► 授权页：不允许 / 仅一次 / 该对话中总是允许
                                      └── 「总是」把这条路径记进「额外可读写文件」，可随时撤销
```

## 五个权限档

| 菜单里的档位 | 预设 id | 读 | 写 | 平台沙箱 |
|---|---|---|---|---|
| 无权限 | `no-access` | 全拒（除非本对话单独授权过该路径） | 全拒 | `read-only` |
| 工作区内读写 | `workspace-access` | 工作区 + 临时目录；以外逐次授权 | 工作区 + 临时目录；以外弹页后仍被沙箱拒绝 | `workspace-write` |
| 只读 | `read-only` | 任意路径 | 全拒 | `read-only` |
| 工作区内编辑 | `workspace-write` | 任意路径 | 工作区 + 临时目录；以外逐次授权 | `workspace-write` |
| 完全访问 | `danger-full-access` | 任意路径 | 任意路径 | `danger-full-access` |

五档按“给多少”排序，但**不是嵌套集合**：只读能读全盘却写不了任何东西，工作区内读写能改工作区却读不到别处。
原有三档的语义、id 与沙箱保持不变，只在其间插入两档。

两条不变量：

- **读写分开**：允许读不等于允许写，反之亦然。面板里可写行也会出现在读框（写蕴含读），撤销时按行/按族区分。
- **失败即拒**：没有可用的提问通道、配置无法识别、路径解析不出来，一律拒绝而不是放行。

## 安装

在目标 profile 的 `package.json` 里挂软链，并把 bundle 加进 `dsh.profile.bundles`：

```json
{
  "dependencies": { "@local/dsh-access-permission": "link:<repo-path>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-access-permission"] } }
}
```

重启 Harness 生效。宿主半（`index.js`/`functions.js`/`cordis.patch.yml`）改动必须重启；`client.js` 改动刷新页面即可。

> ⚠️ 不要在本目录里跑 `npm pack`：它会把 profile 依赖改写成 `file:…tgz` 并把 bundle 从 `dsh.profile.bundles` 里踢掉，
> 结果是插件静默不加载。要打包就复制一份到别处再打（见 [docs/development.md](docs/development.md)）。

## 兼容性

已实测通过（加载、`--dump-config` 合成、真机读写与授权流程）：

| DSH 版本 | 状态 |
|---|---|
| `0.2.1-alpha.1` | 主力开发版本，全量验证 |
| `0.2.2-rc.3` | 已验证：组合配置正确（五档名称、`/tmp` 语义、级别键），启动无报错 |

宿主 API 依赖见 [docs/architecture.md](docs/architecture.md)（服务注入、`tools/pre-execute` 瀑布、`conversation.input.permission` 单座位）。
换新版本时按 [docs/troubleshooting.md](docs/troubleshooting.md) 的“最小 profile 验证法”先验加载，再跑六套自检。

## 命令

| 用法 | 作用 |
|------|------|
| `/access-allow`、`/access-allow list` | 当前级别、预设、scope、额外路径 |
| `/access-allow add <path>` | 加一条读白名单（越级别生效，只读） |
| `/access-allow add-write <path>` | 加一条写授权 |
| `/access-allow remove <path>` / `remove-read` / `remove-write` | 撤销（按族可选） |
| `/access-allow clear` | 清空本对话的额外路径 |

级别本身没有命令：在输入框的权限菜单里切换，控件由本插件接管（座位 `conversation.input.permission`，`priority: -1`）。
完整参数与路径识别规则见 [docs/configuration.md](docs/configuration.md)。

## 文档

| 想了解 | 看这里 |
|--------|--------|
| 项目是什么、术语 | [docs/overview.md](docs/overview.md) |
| 一次调用经过哪些组件、状态存在哪 | [docs/architecture.md](docs/architecture.md) |
| 五档与 `readScope`/`writeScope` 的对应关系 | [docs/levels-and-scopes.md](docs/levels-and-scopes.md) |
| 怎么判定读了什么、写了什么 | [docs/path-analysis.md](docs/path-analysis.md) |
| 授权页怎么弹、授权存哪、怎么失效 | [docs/authorization.md](docs/authorization.md) |
| 控件、面板、弹窗、主题约束 | [docs/ui.md](docs/ui.md) |
| 安装与全部配置项 | [docs/configuration.md](docs/configuration.md) |
| 改代码、调试、发布 | [docs/development.md](docs/development.md) |
| 六套自检测什么 | [docs/testing.md](docs/testing.md) |
| 出问题按症状查 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 关键设计为什么这样定 | [docs/decisions/](docs/decisions/) |

完整文档地图见 [docs/README.md](docs/README.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 文件

| 文件 | 作用 |
|------|------|
| `index.js` | 宿主半：闸门、级别解析、授权页、命令、系统提示 |
| `functions.js` | 纯函数：shell 分析、读写判定、路径归一化与包含判断（可单测） |
| `client.js` | 浏览器半：权限控件、额外路径面板、确认弹窗 |
| `cordis.patch.yml` | 五档预设表 + 插件级别配置 |
| `locale/*.json` | manifest 文案（界面文案在 `client.js` 的字典里） |
| `test/delegation.test.mjs` | 随包测试：委派继承、写切片、解析边角 |
| `docs/` | 上表那份文档 |

## 已知边界

- 包含判断是词法折叠 + `realpath`，不是内核级围栏；插件只决定“该不该做”，写入能否落盘由平台沙箱决定。
- 授权是**对话内内存态**：重启 Harness 后重新询问（取舍见 [ADR 0003](docs/decisions/0003-conversation-scoped-grants.md)）。
- “总是允许”记的是**目录**（本次请求所在目录，覆盖其下全部），不是单个文件。
