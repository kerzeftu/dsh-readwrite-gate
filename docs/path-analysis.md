# 路径判定规则

所有“该不该拦”的问题，最后都归结为三个小问题：

1. 这次调用**读了哪些路径、写了哪些路径**？
2. 这些路径**是不是在范围内**（工作区 / 临时区）？
3. 判断不出来时，按什么**保守规则**处理？

`functions.js` 就是回答这些问题的纯函数集合，`index.js` 只调用它。

## 工具调用的两种形状

`classifyTool(name, args, options)` 先看工具名：

- **已知读工具**（`read`、`glob`、`grep`、`list_dir`…）：取它的路径参数；
  `glob`/`grep`/`list_dir` 没给路径时，缺省搜索目录就是工作区根（`implicit-root`）——否则 `grep {pattern}` 会被当成“什么都没读”直接放行。
- **已知写工具**（`write`、`edit`、`apply_patch`…）：取它的目标路径，按 `applyWriteRule` 的规则决定“哪个参数是写、哪些是读”。
- **未知工具**：递归提取所有像路径的值（深度 ≤ 4，能进到 `files[].path` 这种嵌套结构）；一个都没找到就返回 `undefined`，表示“与文件无关，不管”。

提取靠 `PATH_KEYS` 与 `extractPaths`，但**不能只信键名**：早期版本只看顶层键，`present { files: [{ path }] }` 因此整单绕过判定。

## shell 命令怎么读

`analyzeShell(line)` 是一条流水线：

```
tokenizeShell（将 heredoc 正文附到对应重定向）→ walkScript
   ├── 重定向（`>`、`>>`、`2>`、`>&`）→ 写目标
   ├── 包装命令（env/sudo/timeout/xargs…）→ 解开再看里面的命令
   ├── 赋值（`X=/etc/passwd`）→ 记住，后面 `"$X"` 展开时用
   ├── 只读命令（cat/head/grep/sed…）→ 位置参数即读路径
   ├── 写命令（cp/mv/rm/mkdir/dd…）→ 按 applyWriteRule 决定哪个参数是目标
   ├── 脚本宿主（node/python/bash…）→ 按调用时目录分析内联代码或 heredoc；cat 的正文按数据处理
   └── 未知程序 → opaque
```

几个关键规则，都是被真实误判逼出来的：

| 情况 | 正确行为 | 相关函数 |
|------|----------|----------|
| `cat secret`（无扩展名、无斜杠） | 仍然当路径（`bare` 模式） | `recordWord` / `looksLikePath` |
| `X=/etc/passwd; cat "$X"` | 前置赋值要记住，展开后算读 | `runCommand` + `rememberAssignment` |
| `dd if=/etc/passwd of=/tmp/x` | `if=` 算读、`of=` 算写 | `applyWriteRule`（`of` 规则） |
| `cp /etc/passwd output` | 只有最后一个操作数是写，其余是读 | `applyWriteRule`（`dest` 规则） |
| `curl file:///etc/passwd` | `file://` 是本地路径，不是远程 URL | `fileUrlPath` |
| `rm -f victim` | `-f` 不吃掉 `victim` | `optionTakesValue` |
| `grep -n foo file` | `-n` 不吃 `foo`，`file` 是路径 | 同上 |
| `find /x -name '*.log' -delete` | `-delete` 让整条命令变写；`/x` 是读 | `analyzeFind` |

`optionTakesValue(option, next)` 的原则：**只有下一词既不是选项、又不像路径时才算选项值**。否则像 `rm -f victim` 这种就会把 victim 吞掉，漏判一次删除。

## 路径形态、文件 URL 与折叠

判定前先把词归到一种**形态**（`classifyPathForm`），再按形态折叠（`foldPath`）：

| 形态 | 例子 | 处理 |
|---|---|---|
| `root` | `/etc/hosts`、`\temp\x` | POSIX 从 `/` 开始；Windows 上借基准路径所在的盘符或共享根补齐 |
| `drive` | `C:\Users\me`、`C:/Users/me` | 保留盘符，`..` 最多退到 `C:\` |
| `unc` | `\\server\share\x`、`//server/share/x` | 以 `server\share` 为锚，`..` 不能退到共享之外 |
| `drive-relative` | `C:work` | 相对“该盘当前目录”，无法确定，**拒绝**（`drive-relative`） |
| `device` | `\\?\C:\x`、`\\.\PhysicalDrive0` | 设备命名空间，**拒绝**（`device-path`） |
| `relative` | `notes.txt` | 按基准目录拼接后再折叠 |

两条容易写错的规则：

- POSIX 上反斜杠是**文件名的一部分**，只有 Windows 形态才把它当分隔符。早期实现按两种分隔符一起切，
  会把 `/etc\passwd` 读成 `/etc/passwd`，也会把 `/home/user/a\b` 拆成两层目录。
- 大小写：Windows 形态比较时转小写，POSIX 保持原样。大小写敏感目录上的授权按 POSIX 规则判定。

`file:` URL 只有一个解码入口 `fileUrlPath`：`file:///etc/hosts` → `/etc/hosts`，
`file:///C:/Users/me` → `C:/Users/me`，`file://server/share/x` → `//server/share/x`，
百分号转义会解码。手动输入路径（`normalizeUserPath`）复用同一个入口，所以面板和闸门对同一个
URL 不会给出两种路径。

Windows 规则可以在任何平台上验证：`foldPath` / `containsPath` 接受 `{ windows: true }`，
`test/check-paths.mjs` 就是靠它把共享根、盘符、设备路径、大小写这些用例跑在 Linux CI 上。

## 绝对化、canonical 化与临时区

判定前先把路径统一处理（顺序不能换）：

1. **定基**：相对路径按 `scopeBaseOf(args, root)` 得到的工作目录解析（`workdir` / `cwd` / 会话根），
   再由 `absolutePathOf` 走上面的 `foldPath` 得到绝对词。设备路径与盘符相对路径在这里就返回 `undefined`，
   按“区外”处理。早期实现直接拿相对词去比工作区，被 `/tmp` 前缀吸收，导致“区外目录里 `cat ./secret`”被放行。
2. **折叠**：`canonicalPathOf(path)` = `realpathSync` 解析软链；路径不存在时取最长的已存在祖先逐级解析再拼回来，
   分隔符按 `/` 与 `\` 中较晚的一个切。缓存 2 秒过期（链接改指后能重新解析），超过 4096 条整体清空。
   作用：工作区里指向区外的软链必须按区外处理；`a/../b` 与 `b` 必须是同一行。
3. **临时区**：`insideTempArea(absolute)` 只接受带锚点的绝对路径（`root` / `drive` / `unc`），
   命中 `/tmp` 或 `os.tmpdir()` 即视为内部；原生 Windows 上只认 `os.tmpdir()`，不认字面量 `/tmp`。
4. **包含判断**：`containsPath(canonical, canonicalRoot, canonicalRoot)`，按平台分隔符（POSIX 只认 `/`，Windows 两种都认）；
   设备路径与盘符相对路径直接返回原因，不参与比较。

## opaque

“路径已无法从文本推断”的命令是 opaque：脚本内容读不到、未知程序、`bash -c "$CMD"` 之类。

- 默认 `opaquePolicy: directory`：按它运行的目录判定（运行目录在范围内就放行）。
- `opaquePolicy: deny`：读这一类一律拒绝（`unknown-paths`）。
- 写这一类永远不因 opaque 而“蒙混过关”：要么按运行目录判，要么被级别本身拦下。

## 已知边界

- `containsPath` 是词法折叠 + canonical 化，不是内核级校验；`openat2(RESOLVE_BENEATH)` 那类语义做不到，只能尽量贴近。
- 命令的 `cd` 链只解析到能静态确定的程度；变量拼接出来的目录按 opaque 处理。
- 路径里含不可见字符、超长、`~其他用户` 会被拒绝并给出原因（`PATH_ERRORS`）。
- 面板的手动输入（`normalizeUserPath`）还不按基准盘符补齐 `\temp\x` 这类根相对路径：
  Windows 上它保留原样，闸门侧（`foldPath`）才补齐。两边在“是否在范围内”上仍一致，
  但面板回显的字符串可能与闸门解析结果不同。

改这一层的正确姿势：先写一个能复现误判的断言（`check-gate.mjs` 或 `test/delegation.test.mjs`），再改规则，最后跑负向对照确认断言真能红。

## 受审计的工具

| 工具 | 归入 | 说明 |
|------|------|------|
| `read`、`read_image`、`glob`、`grep`、`lsp`、`terminal_read` | 读 | 参数里的路径；`glob`/`grep` 无路径时用工作区根 |
| `write`、`edit`、`str_replace_editor`、`apply_patch`、`move`、`delete` | 写 | 目标路径即写目标；`apply_patch` 从补丁文本里取路径 |
| `bash`、`pwsh`、`terminal_open` | 读+写 | 整行按 shell 分析 |
| 其他带路径参数的工具 | 写 | 命名了文件就无法证明是只读，保守按写处理 |
| 其余 | — | 与文件无关，直接放行（`classify` 返回 `undefined`） |

## 特殊路径与语法

- `/dev/null`、`/dev/std*`、`/dev/tty`、`/dev/fd/*` 等设备节点不参与围栏：读它们不是“工作区问题”，写它们仍算写。
- heredoc：喂给 shell 或解释器时分析脚本体，否则当数据。
- `$(…)` 与反引号在出现的位置就地分析。
- `cmd 2>&1`、`cmd >&2`、`cmd 2>&-` 只消费文件描述符，不产生路径；早期版本会把 `1` 当成新命令，让一行只读校验被误判成工作区根里的 opaque 写。
- 同一条命令的读与写分开判定：可以“读区内、写区外”，只对区外那一半提问。
- 工作区内能写就静默写：`rm -rf sub`、`mkdir -p a/b/c`、在工作区里启动的脚本都不问。
