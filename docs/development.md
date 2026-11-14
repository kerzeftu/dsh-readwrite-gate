# 开发与调试

## 仓库结构

```
.
├── index.js           宿主半：闸门、命令、授权、状态
├── functions.js       纯函数：切词、读写判定、路径归一化
├── client.js          浏览器半：控件、面板、菜单、确认弹窗
├── cordis.patch.yml   预设表 + 插件配置
├── locale/{zh,en}.json  manifest 文案（界面文案在 client.js 的字典里）
├── icon.svg
├── test/delegation.test.mjs   随包测试（委派继承、写切片、解析边角）
├── docs/              本目录
└── CHANGELOG.md
```

六套自检脚本**不在包里**，在 `<selftest-dir>/`（见 [testing.md](testing.md)）：
它们是开发期资产，随环境走，不进 npm 包。

## 改动怎么生效

| 改了 | 生效方式 |
|------|----------|
| `client.js`、`locale/*.json` | `dsh-client-hmr` 轮询 `mtime/ctime/size`，变化后经 SSE 重新发布；**刷新页面**即可 |
| `index.js`、`functions.js`、`cordis.patch.yml`、profile 配置 | 必须**重启 Harness** |
| `package.json` 的 `dsh.client` 等 | 重启 Harness |

重启命令（本机）：

```bash
node <dsh-dir>/<version>/node_modules/.bin/dsh --profile <profile> --port 10714 --no-open
```

`dsh` 不在 `PATH` 里，必须用全路径。重启前先确认监听端口上的 pid 与 cmdline，避免杀掉别的会话：

```bash
ss -lptn 'sport = :10714'
```

## 调试渠道

宿主半不往 stdout 打日志（在 `dsh web` 下 stdout 是管道），所以排查靠这几条：

1. **模型的工具结果**：拒绝文案本身就是诊断信息（`[access: …]`），先读它。
2. **运行时上下文**：每轮开始注入了当前级别与“已授予的额外路径”，可以直接看出插件状态。
3. **`/access-allow list`**：级别、预设、scope、额外路径、机器标记，一次全给。
4. **会话日志**：`~/.dsh/sessions/<slug>/session-*.v4.jsonl.zstd`，多帧 zstd；逐帧扫 magic `28 b5 2f fd` 再 `zlib.zstdDecompressSync` 解压，可看到每条 `userQuestions.ask` 与工具结果。
5. **临时 occupant 探针**：往 `conversation.input.right` 注册一个高 `order` 的组件，在页面里跑代码，再用
   `ctx.remote.commands.execute(sessionId, '/access-allow list DIAG <encoded>', [])` 把结果写回会话日志。
   这是唯一能拿到“浏览器里真实算出来的东西”的通道（比如 `getComputedStyle` 的颜色）。
6. **`cordis_inspect_query`**：`client Slots listSubTree` 能看座位占用与优先级，`host Config` 能看插件配置；都是只读、拿不到活的 DOM。

## 调试脚本的纪律

- 脚本放 `/tmp` 或仓库外，跑完删掉；不要在包里留探针。
- 探针改了 `client.js` 就**必须**撤掉并重跑六套自检——历史上探针残留过两次。
- 每条 bash 命令的 `/tmp` 是**独立私有目录**，跨命令读写同一个 `/tmp` 文件会失败；需要跨步骤就写到工作区（如 `~/.ap-probe.mjs`）并在结束时清理。

## 安全网会拦的命令

- `rm -rf /home/...`（`rm.recursive-force-home-cwd`）：删目录先 `cd` 到目标父目录再删，或改成 `mv` 到别处。
- `rsync --delete`、`git branch -D`：用安全替代（`git branch -d`、先 checkout 再删）。

## 发布清单

1. `node --check index.js functions.js client.js`
2. 六套自检全绿（见 [testing.md](testing.md)）
3. 负向对照至少跑一条（证明新断言能红）
4. 更新 `CHANGELOG.md`；`package.json` 版本号 +1
5. 刷新桌面副本（`cp -a 源/. 目标/`，`diff -r` 校验）
6. `git commit`（提交信息写清“改了什么、为什么”）
7. 告诉用户哪些改动需要重启、哪些刷新页面即可

## 版本与提交约定

- 语义化版本：修 bug → patch，加档位/加功能 → minor。
- 提交粒度按“一轮可独立验证的改动”，不要让一次提交同时改判定规则和 UI。
- `cordis.patch.yml` 与 `index.js` 的语义必须同源：改档位时预设表、级别表、`MODES`、字典、README、测试一起改。
