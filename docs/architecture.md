# 架构与运行逻辑

一句话：**宿主半做决策，平台沙箱做围栏，浏览器半只负责让用户看得见、改得动。**

## 两个半边

| 半边 | 文件 | 谁加载 | 什么时候生效 |
|------|------|--------|--------------|
| 宿主半 | `index.js`（决策）、`functions.js`（纯函数解析器） | Harness 主进程的 Cordis loader | 插件加载时；改动必须**重启 Harness** |
| 浏览器半 | `client.js` | 浏览器通过 `dsh.bundle.client` 声明拉到，`window.__ModuleLoader__` 装配 | 页面加载时；改动由 HMR 重新发布，刷新页面即可 |

`functions.js` 不 import 任何宿主 API，是可以在 Node 里直接单测的纯逻辑；`index.js` 只做编排。
这条分界的意义：判定规则可以脱离 Harness 复现，测试不用起真机。

## 宿主半依赖的服务

`export const inject = ['tools', 'commands', 'userQuestions', 'permissionPresets', 'sandboxPolicy']`

| 服务 | 用来做什么 |
|------|------------|
| `tools` | 挂 `tools/pre-execute` 瀑布，在工具真正执行前给决策 |
| `commands` | 注册 `/access-allow`（用户侧命令，模型不可达） |
| `userQuestions` | `ask()` 弹出授权页 |
| `permissionPresets` | `current(session)` 拿到当前预设；`catalog()` 给浏览器半的菜单提供名称 |
| `sandboxPolicy` | `resolve({ session })` 拿工作区根 `workspaceRoot` |

另有两个隐式依赖，不在 `inject` 里但通过 `ctx.get()` 软取：`agents` / `sessions`（把 `header.parentSession` 解析成活的父会话对象，用于委派继承）。

## 一次工具调用的完整路径

```
模型调用工具
   │
   ▼
[tools/pre-execute]  ── classify(agent, name, arguments)
   │                     ├── classifyTool()  工具形状：读？写？哪些路径？opaque？
   │                     └── （bash 类）analyzeShell()：切词 → 解析重定向/包装命令/脚本体 → 得到 read/write 路径
   ▼
分类结果 { operation, session, opaque, read, write, root }
   │  classify 返回 undefined ⇒ 与文件无关，直接 next()
   ▼
resolveLevel(session)  ── 预设 → 级别表 → { level, readScope, writeScope, label }
   │
   ▼
按“先写后读”逐族判定（见下文），任一族被拒立即返回 deny
   │
   ▼
next()  ── 放行给工具执行；写入随后仍受平台沙箱约束
```

### 逐族判定顺序（这是全仓最容易改错的地方）

对 `write` 和 `read` 各跑一遍，顺序固定：

1. **这一族有没有内容可判**：有路径、或命令是 opaque、或“已知是修改但目标不可读”。都没有就跳过这一族。
2. **读白名单**（`admittedBy`）：命中的读请求直接放行——这是用户显式列出的例外，优先级高于级别。
3. **级别是 `none`** ⇒ 拒绝（`level-none`）。注意这一步在“对话授权”之前：更宽级别下拿到的授权不能把更窄级别撑开。
4. **委派会话的写切片**：派发者声明的写入范围优先于继承来的级别，越界直接拒绝（`refusalBeyondScope`），不弹页。
5. **该族 scope 是 `none`** ⇒ 拒绝（`level-scope`）；opaque 且无路径的“写”例外跳过（那一档的沙箱本来就拒一切写）。
6. **对话授权命中**（`grantedBy`）⇒ 放行，不再询问。
7. **有区外路径**：scope 是 `anywhere` 直接放行；否则**弹授权页**。回答 `allow-once`/`allow-always` 后**重新解析级别**，若用户在此期间收窄到 `none` 或该族 `scope: none`，仍拒绝。
8. **全部路径都在工作区内**：`opaquePolicy: deny` 且读 + opaque + `scope: workspace` 时拒绝（`unknown-paths`），默认策略不拒。

拒绝文案统一由 `refusal(kind, detail, cause)` 生成，`cause` ∈ `level-none` / `level-scope` / `unavailable` / `unknown-paths` / `rejected`。文案会原样出现在工具结果里，格式被测试锁定，改动需要同步测试。

## 宿主半注册了什么

- `tools/pre-execute` 瀑布：唯一强制入口。
- `commands.register({ name: 'access-allow', … })`：`list / add / add-write / remove / remove-read / remove-write / clear`。
- 每个 agent 一个 `systemPrompt.section({ name: 'access:permission-level', order: 60 })`：把当前级别与“已授予的额外路径”告诉模型，避免它反复试探。
- 事件：`agent/created`（挂提示词）、`agent/disposed`（只清待答队列）、`session/disposed`（清该会话全部缓存）。

## 状态存在哪里

全部在 Harness 进程内存里，没有落盘：

| 结构 | 键 | 值 | 生命周期 |
|------|----|----|----------|
| `liveGrants` | session id | `Map<path, { read, write, directory }>` | 会话销毁时删除；`agent/disposed` **不**删（见下） |
| `readAllow` | session id | `string[]`（`add` 出来的读白名单） | 会话销毁；插件重载即丢，配置项 `allow` 是种子 |
| `askQueues` | session id | 待答授权请求的队列 | agent/session 销毁 |
| `canonicalCache` | 路径 | canonical 化结果 | 全局，容量 4096 后清空 |

两个容易踩的点：

- **`agent/disposed` 不清授权**。DSH 里 agent 会比会话更频繁地重建（比如重新接管同一会话），早期版本在这里清缓存，导致“撤销过的授权又回来了”。现在只有 `session/disposed` 清。
- **授权不进会话日志**。授权页走的是 `userQuestions.ask()` 服务，不是 `ask_user_question` 工具，所以答案不会变成 `tool/call` 记录；`readGrants()` 的日志回放对本插件实际上是空转。历史原因保留了这个函数，但不要指望它恢复授权。设计取舍见 [decisions/0003](decisions/0003-conversation-scoped-grants.md)。

## 浏览器半注册了什么

在 `conversation.input.permission`（单座位）注册权限控件，`priority: -1` 覆盖宿主自带控件；
在 `conversation.input.right`（列表座位）注册「额外可读写文件」控件，`order: 10`；
在 `commandUi` 注册加号菜单入口 `extra-readable-files`。
三者共享一份 `render` 数据流：读 `remote.commands.execute(sessionId, '/access-allow list', [])` 的文本，从中解析 `[allow: …]` 标记。

细节见 [ui.md](ui.md)。

## 扩展点

想加一档权限：改 `cordis.patch.yml` 的预设表与级别表（两处都要），再按需补客户端 `MODES` / `FALLBACK_OPTIONS` / 字典。
想改判定规则：只动 `functions.js`，然后用 `check-gate.mjs` 与 `test/delegation.test.mjs` 验证。
想换授权交互：动 `index.js` 的 `runDialog()` 与 `client.js` 的确认弹窗，但保持“读写分开、答案不越级”这两条不变量。
