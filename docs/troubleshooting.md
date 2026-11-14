# 排障速查

按症状查。每条都是真实踩过的坑。

## 改完没生效

| 现象 | 原因 | 处理 |
|------|------|------|
| 改了 `client.js`，页面没变 | 浏览器保留了旧模块，HMR 没送达或页面没刷新 | 强制刷新（`Ctrl+Shift+R`）；确认 `dsh-client-hmr` 在跑 |
| 改了 `index.js`/预设表，行为没变 | 宿主半只在启动时加载 | 重启 Harness（端口上的 pid + cmdline 确认后再杀） |
| 预设名字还是旧的 | profile 自己的 `cordis.patch.yml` 里有一段 `- id: permission` 遮蔽了 bundle 的预设表 | `dsh --profile <p> --dump-config | grep 工作区内`，两处同步或删掉 profile 里那段 |
| 插件整个不加载 | 在 `link:` 目录里跑过 `npm pack`，profile 依赖被改成 `file:….tgz` 且 bundle 被踢出列表 | 改回 `link:` 依赖并恢复 `dsh.profile.bundles` |

## 界面问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 权限控件还是宿主原版（三档、没图标） | 座位接管失败：`conversation.input.permission` 是 `single`，同优先级注册会抛错并被 inject 延迟路径吞掉 | 确认注册用 `priority: -1`；`check-seat.mjs` 锁着这条 |
| 加号菜单点开是空的 / 打不开 | `commandUi.register` 的 `available()` 抛错，或入口名与宿主命令重名（必须 ASCII 且唯一） | `available()` 里 try/catch；入口名用 `extra-readable-files` |
| 菜单底色发灰 | 用了 `--dsw-alias-bg-overlay`（浅色 `#e9ecf2`） | 用 `--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter` |
| 某一行的颜色是白的（深色主题） | `var(--ap-level-*, #hex)` 里的变量“定义了但值非法”，整条声明失效 → 继承近白色 | 检查 `PALETTE_CSS` 注入的变量值；用 `getComputedStyle` 读实际颜色确认 |
| 显示成“英文”或键名 | 字典缺键时直接渲染键名 | zh/en 两份字典一起加；`check-locale` 会报 |
| 点「选择目录…」后区域消失 | 目录浏览器状态被覆盖导致 anchor 丢失、组件抛错被 error boundary 卸载 | 用函数式合并保留 anchor；`listingTicket` 丢弃过期响应 |

## 行为问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 每次读写 `/tmp` 都弹授权页 | `/tmp` 被判成工作区外 | 确认 `insideTempArea()` 生效（只接受绝对路径，命中 `/tmp`、`os.tmpdir()`） |
| 区外目录里 `cat ./x` 直接放行 | 相对路径被当成绝对词、被临时区前缀吸收 | 先按 `workdir`/`cwd` 定基再判 |
| 工作区内软链指向区外仍可读 | 只做了词法折叠 | 用 `canonicalPathOf`（realpath + 父级回退） |
| 撤销过的授权又出现 | 在 `agent/disposed` 里清了缓存（agent 会比会话更频繁地重建） | 只在 `session/disposed` 清 |
| 等授权时把级别降下来，回答“仅一次”仍然放行 | 级别只在 await 前解析 | 回答后重新 `resolveLevel`，收窄则按 `level-none`/`level-scope` 拒 |
| 删除只读授权抛 `TypeError … setting 'write'` | 同一行被两次 `get`，第二次拿到 undefined | 重新取行并判空 |
| 预设显示成“无权限”而实际不是 | 宿主 `derive()` 在 `state.preset` 失配时取第一个 knob 相同的预设（历史三档都是 `read-only + ask`） | 保证 `state.preset` 不丢；必要时让各档 knob 互不相同 |

## 环境相关

| 现象 | 原因 | 处理 |
|------|------|------|
| 新版本 DSH 上插件不加载 | 宿主 API 签名或座位规则变了 | 对照 `--dump-config`、`inject` 服务、`slots` 规则；参考 rc.3 的兼容验证方法 |
| 官方 profile 启动失败、日志提到 `dsh-socrates`/`dsh-synapse` | 第三方插件与本机数据版本冲突，与权限插件无关 | 换最小 profile 验证本插件（见下） |
| `mkdir /opt/...` 报只读 | 本机 `/opt` 不可写 | 用 `~` 下真实存在的路径做测试 |
| 跨命令 `/tmp` 文件读不到 | 每条 bash 命令的 `/tmp` 是独立私有目录 | 同一命令内产生并使用，或写到工作区 |

## 最小 profile 验证法

怀疑“是不是插件的问题”时，建一个只装 base + web-app + 本插件的 profile：

```bash
mkdir -p ~/.dsh/profiles/ap-check
# package.json: bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-readwrite-gate"]
# node_modules → 指向已有 profile 的 node_modules 软链
dsh --profile ap-check --port 10999 --no-open
```

启动无报错即说明加载链路没问题；剩下的差异就在插件配置或预设表上。

## 收集诊断信息给维护者

1. 当前级别与额外路径：`/access-allow list` 的完整输出。
2. 出错那次的工具结果原文（含 `[access: …]` 文案）。
3. `dsh --profile <p> --dump-config` 里 `permission` 与 `readwrite-gate` 两段。
4. 插件版本（`package.json`）与 DSH 版本。
