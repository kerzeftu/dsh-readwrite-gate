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
splitHeredocs → tokenizeShell → walkScript
   ├── 重定向（`>`、`>>`、`2>`、`>&`）→ 写目标
   ├── 包装命令（env/sudo/timeout/xargs…）→ 解开再看里面的命令
   ├── 赋值（`X=/etc/passwd`）→ 记住，后面 `"$X"` 展开时用
   ├── 只读命令（cat/head/grep/sed…）→ 位置参数即读路径
   ├── 写命令（cp/mv/rm/mkdir/dd…）→ 按 applyWriteRule 决定哪个参数是目标
   ├── 脚本宿主（node/python/bash -c…）→ 递归 walkScript 脚本体
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

## 绝对化、canonical 化与临时区

判定前先把路径统一处理（顺序不能换）：

1. **定基**：相对路径按 `scopeBaseOf(args, root)` 得到的工作目录解析（`workdir` / `cwd` / 会话根）。
   早期实现直接拿相对词去比工作区，被 `/tmp` 前缀吸收，导致“区外目录里 `cat ./secret`”被放行。
2. **折叠**：`canonicalPathOf(path)` = `realpathSync` 解析软链；路径不存在时逐级 canonical 化父目录再拼回来。上限缓存 4096 条。
   作用：工作区里指向区外的软链必须按区外处理；`a/../b` 与 `b` 必须是同一行。
3. **临时区**：`insideTempArea(absolute)` 只接受**绝对路径**，命中 `/tmp` 或 `os.tmpdir()` 即视为内部。相对词不再被它吞掉。
4. **包含判断**：`containsPath(canonical, canonicalRoot, canonicalRoot)`，按平台分隔符（POSIX 只认 `/`，Windows 两种都认）。

## opaque

“路径已无法从文本推断”的命令是 opaque：脚本内容读不到、未知程序、`bash -c "$CMD"` 之类。

- 默认 `opaquePolicy: directory`：按它运行的目录判定（运行目录在范围内就放行）。
- `opaquePolicy: deny`：读这一类一律拒绝（`unknown-paths`）。
- 写这一类永远不因 opaque 而“蒙混过关”：要么按运行目录判，要么被级别本身拦下。

## 已知边界

- `containsPath` 是词法折叠 + canonical 化，不是内核级校验；`openat2(RESOLVE_BENEATH)` 那类语义做不到，只能尽量贴近。
- 命令的 `cd` 链只解析到能静态确定的程度；变量拼接出来的目录按 opaque 处理。
- 路径里含不可见字符、超长、`~其他用户` 会被拒绝并给出原因（`PATH_ERRORS`）。

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
