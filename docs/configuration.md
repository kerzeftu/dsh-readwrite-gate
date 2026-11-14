# 安装、配置与命令

## 安装到一个 profile

插件以 `link:` 方式装进某个 Harness profile（本机是 `<profile-dir>`）：

1. `package.json` 的 `dependencies` 增加
   `"dsh-readwrite-gate": "link:<repo-path>"`；
2. `dsh.profile.bundles` 里加上 `dsh-readwrite-gate`；
3. 重启 Harness。

`link:` 是软链：浏览器拿到的就是仓库里的活文件，全盘只有一份副本。

已在 DSH `0.2.1-alpha.1` 与 `0.2.2-rc.3` 上验证（组合配置与真机行为）。其他版本先按
[troubleshooting.md](troubleshooting.md) 的“最小 profile 验证法”确认能加载。


> ⚠️ **不要在这个目录里跑 `npm pack`**。`npm pack` 会把 profile 的依赖改写成 `file:…tgz`
> 并把 bundle 从 `dsh.profile.bundles` 里踢掉，结果插件整个不加载且没有明显报错。
> 需要打包就复制一份到别处再打。

## 两层配置：预设表 + 级别表

`cordis.patch.yml` 做两件事：

1. **覆盖宿主预设表**（`- id: permission`）：`presets` 是整体替换，不是合并。键顺序就是菜单顺序。
2. **插入插件**（`- insert: - id: readwrite-gate`）：给出级别表与插件行为配置。

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      no-access: { sandbox: read-only, approval: ask, name: 无权限, description: … }
      workspace-access: { sandbox: workspace-write, approval: ask, name: 工作区内读写, … }
      read-only: { sandbox: read-only, approval: ask, name: 只读, … }
      workspace-write: { sandbox: workspace-write, approval: ask, name: 工作区内编辑, … }
      danger-full-access: { sandbox: danger-full-access, approval: !!js "…", name: 完全访问, … }

- insert:
    - id: readwrite-gate
      name: 'dsh-readwrite-gate'
      config:
        levels: { … }
        defaultLevel: no-access
        treatReadOnlyAsNoAccess: false
        opaquePolicy: directory
```

### 级别表的一项

```yaml
levels:
  workspace-edit:                 # 键名任意，被 presetLevels / defaultLevel 引用
    preset: workspace-access      # 绑定的预设 id（权威：写了就以它为准）
    level: workspace              # full | workspace | none
    readScope: workspace          # anywhere | workspace | none
    writeScope: workspace
    label: 工作区内读写            # 菜单与提示词里显示的名字
    description: …
```

实际生效的五项：`no-access`（level none）、`workspace-edit`（preset `workspace-access`）、
`read-only-access`（preset `read-only`）、`workspace-write-access`（preset `workspace-write`）、`full-access`。
完整语义见 [levels-and-scopes.md](levels-and-scopes.md)。

### 插件配置字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `levels` | `{}` | 级别表，见上 |
| `presetLevels` | `{}` | 预设 id → 级别表键（级别表项没写 `preset` 时用） |
| `defaultLevel` | `none` | 匹配不到时的兜底；未识别的值收敛到全拒 |
| `treatReadOnlyAsNoAccess` | `true` | 旧语义兼容：把 `read-only` 沙箱当无权限 |
| `opaquePolicy` | `directory` | opaque 命令按运行目录判；`deny` 则读侧一律拒 |
| `allow` | `[]` | 读白名单种子（`/access-allow add` 的初始值） |

## profile 里可能存在的“影子预设表”

profile 自己的 `cordis.patch.yml` 若也写了一段 `- id: permission`，它会在合成时**遮蔽**插件 bundle 里的预设表：
菜单里显示旧名字，但插件级别表已经改成新名字，两边对不上。

排查方法：`dsh --profile <name> --dump-config | grep -n "工作区内"`。
两处都要同步，或者干脆删掉 profile 里那段。

## 命令：`/access-allow`

| 用法 | 作用 |
|------|------|
| `/access-allow` 或 `/access-allow list` | 打印当前级别、预设、scope 与额外路径（含机器可读标记） |
| `/access-allow add <path>` | 加一条**读**白名单；越级别生效，只读 |
| `/access-allow add-write <path>` | 加一条**写**授权（等价于授权页选了“总是可以修改”） |
| `/access-allow remove <path>` | 撤掉该路径的读与写 |
| `/access-allow remove-read <path>` | 只撤读；若该行同时可写，整行移除（写蕴含读） |
| `/access-allow remove-write <path>` | 只撤写 |
| `/access-allow clear` | 清空本对话的额外路径 |

路径参数会被识别而不是当字面量：引号、`~`、`$HOME`、`file://`、相对路径（按工作区根）、`..`、Windows 盘符映射都会归一化；
不存在但合法的路径也接受（写新文件需要）；无法识别的写法会被拒绝并给出原因。

命令输出末尾带两个机器可读标记：

- `[allow: <path>|<flags>… ]`：给浏览器面板解析的行（`\x01` 分隔，flags `r`/`w`/`rw` + `d`）。
- `[extra: 读 /etc/ …]` 或 `[extra: none]`：给模型看的自然语言摘要。

## 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里删掉，重启 Harness。
会话里残留的级别名会失配到 `defaultLevel`（全拒），不会放宽权限。

## 桌面导出（本机习惯）

```bash
mkdir -p ~/Desktop/dsh-readwrite-gate-plugin
cp -a <repo-path>/. ~/Desktop/dsh-readwrite-gate-plugin/
```

COPY 不带 `.git`，需要历史的副本另外 `tar` 整个仓库。
