# 安装、配置与命令

## 安装

从 [GitHub Releases](https://github.com/kerzeftu/dsh-readwrite-gate/releases) 下载 `.tgz` 附件并解压，或克隆仓库。解压后的 `package` 目录或仓库根目录均可作为本地插件目录；请将其放在固定位置，不要在安装后移动。

建议通过 DSH 的插件管理功能安装本地目录。若手动维护 profile，需同时添加依赖和 bundle 条目：

1. 在目标 profile 的 `package.json` 中，将 `"dsh-readwrite-gate": "link:<repo-path>"` 加入 `dependencies`。
2. 将 `dsh-readwrite-gate` 加入 `dsh.profile.bundles`，保留原有条目，并使用该 profile 的包管理方式安装依赖。
3. 重启 Harness，确认权限菜单中出现“无权限”和“工作区内读写”。

`<repo-path>` 是本地插件目录的绝对路径，不能原样保留。`link:` 安装直接引用该目录，修改目录中的文件也会影响已安装的插件；安装或升级后应重启 Harness。

版本验证范围：DSH `0.2.1-alpha.1` 已进行全量验证；`0.2.2-rc.3` 已验证配置组合与启动。其他版本应先在独立 profile 中测试，方法见[故障排查](troubleshooting.md)。

开发时不要直接在已通过 `link:` 安装的目录中打包。本项目曾遇到打包操作改变 profile 依赖的情况；发布包应从独立副本生成，步骤见[开发指南](development.md)。

日常使用通常不需要修改下列级别配置，可以直接阅读本文后面的命令用法。

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
| `grantPersistence` | 不启用 | 仅在部署者确认宿主后端受保护时设为 `protected-backend`；详见[授权有效期](authorization.md#授权有效期) |

### 选择授权存储后端

- **复用宿主后端**：仅当现有默认后端及其配置均不在模型工具的写入权限内时，启用 `grantPersistence: protected-backend`。保留 `storage-domain` 的默认 `backend`，无需添加域路由。
- **单独隔离**：先让宿主注册具有 `kv` 能力的受保护后端，再把 `storage-domain` 的 `routes.readwrite_gate_grants` 设为该后端的注册名。保留原有 `backend` 和其他路由，最后启用 `grantPersistence: protected-backend`。这条路由只影响司门，不移动其他 Harness 数据。

司门不会自行创建隔离后端。不要仅把普通 JSON 目录换到另一个可写位置，也不要让两个独立运行的 Harness 实例同时写同一 profile 的授权记录。后端必须能原子替换同一会话的记录。无法确认这些条件时，保持默认内存模式。

## profile 中的重复预设配置

如果安装或升级后，菜单仍显示旧名称，请检查 profile 的 `cordis.patch.yml` 是否另有 `- id: permission` 配置。这段配置可能覆盖插件提供的预设表。

可用以下命令查看最终合成的配置，`<name>` 应替换为 profile 名称：

```bash
dsh --profile <name> --dump-config
```

检查其中的权限名称与沙箱设置。若 profile 确有重复配置，应同步更新；如不再需要该覆盖项，备份后再移除，不要直接删除其他插件使用的配置。

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

路径参数支持引号、`~`、`$HOME`、`file://` 和 `..`，相对路径以工作区根目录为基准。在有相应挂载的环境中，也支持 Windows 盘符映射。

合法但尚不存在的路径可以添加，以便为新文件或目录预先设置权限。无法识别的路径会返回错误说明。

命令输出末尾带两个机器可读标记：

- `[allow: <path>|<flags>… ]`：给浏览器面板解析的行（`\x01` 分隔，flags `r`/`w`/`rw` + `d`）。
- `[extra: 读 /etc/ …]` 或 `[extra: none]`：给模型看的自然语言摘要。

## 卸载

通过 DSH 的插件管理功能移除本插件。若使用手动配置，则从目标 profile 的 `dependencies` 和 `dsh.profile.bundles` 中移除 `dsh-readwrite-gate`，并检查是否还有为本插件单独添加的预设覆盖项。

卸载后重启 Harness，并重新选择宿主提供的权限档位。卸载会移除插件的读取限制和额外授权功能，不能将其视为“无权限”模式。
