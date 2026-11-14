# 访问权限插件 · 修复方案（按目录校验 + 目录递归授权）

> 状态：**方案稿，尚未改代码**。确认后再实施。
> 依据：用户 2026-10-24 提出的三个要点（逐字引用见下），以及当前代码总览。

## 0. 验收标准（用户原话，先记住）

1. 「遇到命令校验命令访问或修改的目录而不是直接拦截」
2. 「允许修改一个目录的时候默认允许修改这个目录下的其他目录和其中所有文件」
3. 「工作区可写状态默认允许访问和修改工作区目录内目录和文件」

一句话概括：**判定的单位从“单个文件”改成“目录”，并且永远先校验、不直接拦。**

---

## 1. 插件总览（现状态）

### 1.1 文件与职责

| 文件 | 职责 |
|---|---|
| `index.js`（984 行） | 宿主半：级别解析、闸门（`tools/pre-execute`）、授权弹窗、`/access-allow` 命令、系统提示词、状态标记 |
| `functions.js`（1145 行） | 纯规则：shell 分析器、工具归类、路径包含、白名单匹配（可单测，不依赖宿主） |
| `client.js`（1252 行） | 浏览器半：输入框的权限控件、右侧“额外可读写文件”控件与面板 |
| `cordis.patch.yml` | 权限预设表（原 3 个 + 新增 2 个）与插件行 |
| `locale/*.json` | 插件元信息文案 |
| `README.md` | 面向使用者的说明 |

### 1.2 五个权限级别（`cordis.patch.yml`）

| 控件显示 | 预设 | level | readScope | writeScope | 一句话 |
|---|---|---|---|---|---|
| 无权限 | `no-access` | none | — | — | 读/写都拒 |
| 工作区内查看 | `workspace-access` | workspace | workspace | none | 只读区内，区外读弹窗，任何修改都拒 |
| 只读 | `read-only` | workspace | anywhere | none | 读哪都行，修改一律拒 |
| 工作区可写 | `workspace-write` | workspace | anywhere | workspace | 读哪都行，区内随便改，区外改弹窗 |
| 完全访问 | `danger-full-access` | full | — | — | 不拦 |

### 1.3 闸门流程（`index.js:665-730`）

```
tools/pre-execute
  └─ classify()                       index.js:521
       ├─ classifyTool(name,args)     functions.js:962  → {kind, paths, readPaths, writePaths, opaque, command}
       ├─ familyState(read)           index.js:496     → {paths, outside, admittedBy, grantedBy}
       └─ familyState(write)
  └─ 依次判写、判读（写优先）
       full → allow
       白名单命中（仅读族）→ allow
       level none → deny
       scope none → deny                       ← 级别语义，不是“路径拦截”
       grantedBy 全命中 → allow
       区外路径 → 弹窗（ask）→ 允许 / 拒绝
       区内 → allow
       ★ 读 + opaque + scope=workspace → deny「无法确定这个命令要访问的路径」  ← 要点1 要拆掉的
  └─ next()
```

### 1.4 授权模型

- **会话日志回放**：`grantEntriesOf`（`index.js:371`）从 `userQuestions` 的问答记录里恢复本对话授权；`readGrants` 只把「总是」答案算作授权。
- **按路径记录**：`liveGrants: Map<sessionId, Map<path,{read,write}>>`；`grantPaths`（`index.js:399`）在弹窗选「总是」时写入（`index.js:630-634`）。
- **白名单**：`readAllow`（配置 `allow` 种子 + `/access-allow add` 编辑），只作用于读族，且优先于级别（运维例外）。
- **匹配语义**：`allowedBy`（`functions.js:1114-1124`）——**条目覆盖自身及其所有后代**，所以目录条目本来就递归；文件条目只覆盖自己。
- **面板**：两个框分别读 `[allow: path|r/w]` 标记，✕ 调 `/access-allow remove-read|remove-write`。

### 1.5 已知限制（本次不扩大）

- 路径包含是**词法**的（`..` 折叠、不解析符号链接）；`~` 不支持。
- 无可用交互界面（子代理、无问答 UI）时 fail-closed。
- 完全访问级别不拦任何东西。

---

## 2. 要点 1：按目录校验，不直接拦截

### 2.1 现状问题

1. `index.js:725-727`（配合 `refusal` 的 `unknown-paths` 文案 `index.js:659-661`）：读族 + `opaque` + `scope=workspace` 时**直接拒绝**。这就是“工作区内查看”级别下 `node build.mjs`、`bash script.sh` 被拦的原因——脚本的路径命令行里读不出来。
2. 未知目标（`rm -rf $TARGET`）走 `side.kind === 'write' && operation.kind === 'write'` 的 present 规则，在工作区可写级别被放行、在写受限级别按级别拒绝；这里没有“目录校验”。
3. 判定顺序里没有任何“目录”概念——只有具体路径。

### 2.2 方案：为“读不出自身路径”的命令推导**校验目录**

对 opaque 命令（任意脚本 / 未知可执行），在 `analyzeShell` 里额外产出 `targetDirs`：

| 来源 | 示例 | 推导 |
|---|---|---|
| 脚本文件所在目录 | `node /tmp/x/build.mjs` | `/tmp/x` |
| 生效工作目录 | 从同一行的 `cd` 推；没有就是工具参数 `cwd/workdir`，再没有就是工作区根 | `~` |
| 命令行里出现的字面路径及其父目录 | `bash /tmp/run.sh --conf /etc/app.conf` | `/tmp`、`/etc` |
| 完全推导不出 | `node`、`sh`（读 stdin） | 只保留工作目录 |

然后判定阶梯**只多一条**、少一条：

- 删除 `unknown-paths` 直接拒绝分支；
- opaque 读族把 `targetDirs` 当作自己的 `paths` 参与原有判定：
  - 全部在区内 → allow（要点 1 的目标行为）；
  - 有区外目录 → **弹窗询问**（把目录列出来），可选「不允许 / 仅一次 / 该对话中总是…」；
  - 弹窗不可用 → 照旧 fail-closed；
- 写族不变：`scope=workspace` 时脚本的写由级别自带沙箱兜住（`index.js:707` 的豁免保留），`scope=none` 时级别拒绝。

### 2.3 影响与风险

- **读闸门对脚本变弱**：`node build.mjs` 内部若 `read('/etc/passwd')`，命令行看不出来 → 放行。这是“不直接拦截”的代价，属于用户明确要求；写侧仍有沙箱与级别兜底。
- 缓解：提供配置 `opaquePolicy: 'directory'（默认，按要点 1）| 'deny'（严格旧行为）`，默认按目录；需要严格时一行配置切回。
- 目录推导表必须可枚举、可测：新增 `check-gate` 断言覆盖“脚本区内→放行、脚本区外→弹窗、字面参数区外→弹窗、无参数→按 cwd”。

---

## 3. 要点 2：允许一个目录 = 允许其下全部内容

### 3.1 现状问题

- `allowedBy` 的**匹配**已经是递归的（`functions.js:1114-1124`：条目覆盖自身与所有后代），`add-write <目录>` 也已经是递归授权。
- **缺口在“记录”那一侧**：弹窗选「该对话中总是…」时，`runDialog`（`index.js:630-634`）把**本次请求的具体路径**原样写入 `grantPaths`。请求若是文件（`sed -i /tmp/a/b.txt`、`> /tmp/a/out.log`），授权只覆盖那个文件；同一目录下的其他文件、子目录仍然逐次弹窗 → 用户感知为“不递归”。

### 3.2 方案：授权页的「总是」改记**目录**

- 新增 `directoryOf(path)`（纯字符串，不 stat）：
  - 以 `/` 结尾、或由命令语义判定为“目录操作”的路径（`rm -r`/`rmdir`/`mkdir -p`/`find -delete` 的根、`mv` 的目标）→ 取**路径本身**；
  - 其余（文件写入目标、重定向目标、`sed -i` 目标、`cp` 目标…）→ 取**父目录**。
- `runDialog` 的「总是」分支改为 `grantPaths(session, kind, paths.map(directoryOf))`（写族；读族保持精确路径，保留之前的最小授权体验）。
- 弹窗「总是」文案改成明示：**「把 `<目录>` 及其下所有文件和子目录记入本对话的额外路径…」**（`index.js:78-80` 的 `description` 函数）。
- 面板/命令里的目录条目已天然递归（`allowedBy`），无需改匹配；`allowHint` 已写“目录包含其下全部内容”，保留并补充“授权页记录的是目录”。

### 3.3 兼容与撤销

- 旧会话日志里按文件记录的授权**不重写**：继续精确生效（不扩大），新授权才按目录。
- 撤销：✕ / `remove-read|remove-write` 删除目录条目 → 整棵子树回到逐次询问（`allowedBy` 语义保证，无需新逻辑）。
- 风险：一次授权覆盖整目录，粒度变宽。缓解：弹窗文案明示目录；「仅一次」仍只对本次生效；面板可随时撤销；需要单文件长期授权时用 `/access-allow add <文件>`（白名单条目可精确到文件）。

---

## 4. 要点 3：工作区可写 = 区内目录与文件默认放行

### 4.1 现状核对（逐条对照）

| 场景 | 现在 | 依据 |
|---|---|---|
| 区内读（绝对路径） | allow | `readScope=anywhere` → `decideSide` 的 `scope='anywhere'` |
| 区内写（绝对路径） | allow，不弹窗 | `outside` 为空 → 循环直接 `next()`（`index.js:713-721`） |
| 相对路径 | 以 `cwd/workdir` 或工作区根为基准 | `scopeBaseOf`（`functions.js:1063`） |
| `.` / `..` / 尾斜杠 | 词法折叠 | `containsPath`（`functions.js:1020`） |
| 工作区根自身 | 算区内 | `resolved === rootResolved` |
| 空格/中文/多层目录 | 与绝对路径一致 | 同一套词法 |

### 4.2 结论与动作

- **语义已经满足**，本次不改级别定义（`workspace-write` 仍是 read anywhere / write workspace）。
- 需要做的是**用测试锁死**，防止“目录校验”改造把它改坏：新增 `check-gate` 矩阵覆盖 `mkdir -p`、`cp -a`、`mv`、`rm -rf`、`sed -i`、重定向、heredoc、`find -delete`、相对/`.`/`..`/根/中文空格，全部区内 ⇒ 一律 `allow` 且**弹窗次数 0**。
- 唯一保留的例外：`scope=none`（只读、工作区内查看）继续拒绝写——那是级别定义，不是要点 3 的目标；本轮不动。

---

## 5. 改动清单（文件 / 函数 / 行号，实施时按此执行）

### functions.js
- 新增 `directoryOf(path)`：纯字符串；`/` 结尾或调用方声明为目录时取自身，否则取父目录（根路径 `/` 父目录仍是 `/`）。
- `analyzeShell`（`functions.js:369-410`）：opaque 时补 `targetDirs`（脚本文件目录、生效 cwd、字面路径参数的目录）；`WRITE_RULES`/`applyWriteRule` 标注每个写目标是“目录操作”还是“文件操作”（供 `directoryOf` 使用）。
- 保持 `containsPath` / `allowedBy` / `decideSide` 语义不变（`decideSide` 不变，opaque 的目录只是填入 `paths`）。

### index.js
- `classify`（`:521-540`）：把 `targetDirs` 并入读族的 `paths`（仅 opaque）。
- 闸门（`:665-730`）：删除 `unknown-paths` 分支与其文案（`refusal` `:659-661`）。
- `runDialog`（`:600-639`）：「总是」记录 `directoryOf(paths)`（写族）；文案加“目录及其下全部内容”。
- `refusal`：删除 `unknown-paths`；新增（如需要）opaque 目录越界沿用普通 `rejected` 文案。
- `levelText`（`:923-957`）：把“命令按真实路径判断”一句改成“按路径/目录判断；脚本按所在目录与工作目录校验”。
- `allowCommand` 帮助文案：补“目录条目覆盖其下全部内容”。
- 配置项 `opaquePolicy`（默认 `directory`）。

### client.js
- `allowHint`（`client.js:203/240` 附近）：补一句“授权页的‘总是’记录的是目录”。
- 面板行：目录条目可加 `/` 后缀（可选，纯显示）。
- 其余（两框结构、✕ 分族）不动。

### README.md
- 更新 “What is audited”：目录校验规则、opaque 目录推导、写授权按目录记录、工作区可写矩阵。

### 测试
- `check-gate.mjs` 新增约 35 条：目录推导、opaque 目录判定、按目录授权、工作区可写矩阵（见 §6）。
- 负向对照 3 个：①把 `unknown-paths` 直接拒绝塞回去 ⇒ “opaque 脚本区内放行”相关断言必须红；②把「总是」改回记精确文件 ⇒ “授权后同目录其他文件不再弹窗”必须红；③把 `scope=none` 的写放行 ⇒ “只读/工作区内查看拒绝写”必须红。

---

## 6. 测试矩阵（新增断言要点）

1. **目录推导**：`sed -i /tmp/a/b.txt` → 记录目录 `/tmp/a`；`rm -rf /tmp/build` → `/tmp/build`；`rmdir /tmp/x` → `/tmp/x`；`mkdir -p /tmp/a/b` → `/tmp/a`；`> /tmp/a/out.log` → `/tmp/a`；`cp /tmp/a ~/b` → 读 `/tmp/a`、写 `~`；`mv /tmp/a ~/b` → 写 `/tmp` 与 `~`。
2. **opaque（要点 1）**：工作区内查看下 `node build.mjs`（cwd=工作区）⇒ **allow**；`node /tmp/x.mjs` ⇒ **ask**（列出 `/tmp`）；`bash /tmp/run.sh --conf /etc/app.conf` ⇒ ask（列出 `/tmp`、`/etc`）；`node` 无参数 ⇒ 按 cwd；全部区外且用户选「不允许」⇒ deny。
3. **目录授权（要点 2）**：`sed -i /tmp/a/b.txt` 选「总是」⇒ 面板出现 `/tmp/a`；随后写 `/tmp/a/c.txt`、`/tmp/a/sub/d.txt` ⇒ 不再弹窗；`remove-write /tmp/a` 后再写 ⇒ 重新弹窗；读族不受该写授权影响。
4. **工作区可写（要点 3）**：§4.2 矩阵全部 `allow` 且弹窗 0 次。
5. **不回退**：无权限仍全拒（白名单读例外保留）；只读/工作区内查看的写仍拒；`/dev/null` 等中立路径仍不算越界；fail-closed（无问答 UI）仍拒绝。

---

## 7. 实施顺序

1. `functions.js`：`directoryOf` + `analyzeShell` 的 `targetDirs` + 写规则标注。
2. `index.js`：classify / 闸门 / runDialog / refusal / 文案 / `opaquePolicy`。
3. `check-gate.mjs` 新断言 + 跑六套回归。
4. 三个负向对照（每个都要“改坏就红”，否则断言不算锁住）。
5. `client.js` 文案、README。
6. 重启 Harness 真机验收：用户之前被拒的六种形态 + 目录授权递归 + 工作区可写矩阵；客户端文案刷新页面即可。

---

## 8. 需要确认的三个选择

1. **弹窗「总是」的粒度**：写族记录“请求路径所在目录”（本方案，符合要点 2）；读族保持精确路径（保留最小授权）。是否两个族都按目录？
2. **opaque 脚本在“工作区内查看”级别**：按目录校验后放行（本方案，符合要点 1）；是否还要保留“直接拒绝”的开关 `opaquePolicy=deny`？
3. **面板里目录条目的显示**：是否给目录条目加一个 `/` 后缀以示递归？（不影响判定，只是观感）

## 9. 实施状态

三要点已实现并通过六套自检（check-gate 156 项）：

- **要点 1（按真实路径判定）**：`functions.js` 的 `analyzeShell` 在收集读写路径之外，另记 `targetDirs`（opaque 命令的判定目录，追踪 `cd` 与当前工作目录）与 `writeDirTargets`（rm -r / rmdir / mkdir 的操作数、`find -delete` 的根），`directoryOf()` 负责由文件路径推出所在目录；授权页与闸门都改用目录。
- **要点 2（允许目录＝允许整棵树）**：`grantTargetsOf()` 把每次“总是”的答案记成目录（已知目录保留自身，其余取父目录），`allowedBy()` 的子树匹配让后续同目录文件与子目录不再询问；面板行以 `/` 结尾显示并可单独撤销读或写。
- **要点 3（工作区可写＝区内静默）**：工作区可写级别下区内 `rm -rf`、`mkdir -p`、就地修改、区内脚本全部直接放行、不弹窗，已用测试矩阵锁死。
- **opaquePolicy**：`cordis.patch.yml` 默认 `directory`（按工作目录校验）；设为 `deny` 恢复“读侧受限于工作区时拒绝不可读命令”的旧规则。
