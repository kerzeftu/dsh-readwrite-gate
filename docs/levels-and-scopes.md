# 权限档、级别与范围

## 三套名字，别混

| 层 | 名字 | 出现位置 |
|----|------|----------|
| 用户看到的档名 | 无权限 / 工作区内读写 / 只读 / 工作区内编辑 / 完全访问 | 预设表的 `name`，以及级别表的 `label` |
| 预设 id（持久化在会话状态里） | `no-access` / `workspace-access` / `read-only` / `workspace-write` / `danger-full-access` | `cordis.patch.yml` 的 `presets` 键；会话记录的是这个 |
| 插件级别 | `full` / `workspace` / `none` | 级别表的 `level` |
| 范围 | `readScope` / `writeScope` ∈ `anywhere` / `workspace` / `none` | 级别表 |

**预设 id 是持久化契约**：改名会让旧会话的 `state.preset` 失配、回退到 `defaultLevel`。
所以「工作区内查看→工作区内编辑→工作区内读写」这一路只改 `name`/`label`，id 一直是 `workspace-access`。

## 五档到范围的映射（当前配置）

| 预设 | 级别 | readScope | writeScope | 平台沙箱 |
|------|------|-----------|------------|----------|
| `no-access` | `none` | （被级别 `none` 覆盖） | （同上） | `read-only` |
| `workspace-access` | `workspace` | `workspace` | `workspace` | `workspace-write` |
| `read-only` | `workspace` | `anywhere` | `none` | `read-only` |
| `workspace-write` | `workspace` | `anywhere` | `workspace` | `workspace-write` |
| `danger-full-access` | `full` | （被 `full` 覆盖） | （同上） | `danger-full-access` |

判定时级别与范围是叠加的：

- `level: none` ⇒ 两族都拒，不看 scope。
- `level: full` ⇒ 两族都放行，不看 scope（除非是带写切片的委派会话，见下）。
- `level: workspace` ⇒ 各族按自己的 scope 决定。

注意 `read-only` 这一档的 `level` 是 `workspace` 而不是别的：它只是“写这边 scope 是 none”，读那边是 `anywhere`。

## 为什么“工作区内读写”的沙箱是 `workspace-write`

这一档承诺“工作区里可以改”，而平台的 `read-only` 沙箱会拦掉一切写——包括工作区里的写。两套围栏必须一致，否则用户看到的是“插件放行了、平台又拒了”。
所以：

| 档 | 插件决策 | 平台沙箱 | 叠加结果 |
|----|----------|----------|----------|
| 工作区内读写 | 区内读写放行、区外读弹页、区外写弹页 | `workspace-write` | 区外写“先问再拒”，与工作区内编辑一致 |
| 工作区内编辑 | 读全放行、区内写放行、区外写弹页 | `workspace-write` | 同上 |
| 只读 | 读全放行、写全拒 | `read-only` | 任何写都到不了沙箱 |

“区外写弹页后仍被拒”是刻意的：授权页回答的是“允许修改”，但平台围栏不认这份授权。要真正写区外，只能切到完全访问。

## 非嵌套的阶梯

五档按“给多少”排序，但不是包含关系：

```
无权限 ⊂ 工作区内读写 ⊂ 工作区内编辑 ⊂ 完全访问      （写的能力）
无权限 ⊂ 工作区内读写           只读 ⊂ …            （读的能力）
```

只读能读全盘却写不了工作区，工作区内读写能写工作区却读不到别处。文档和 UI 都按“排序”而不是“包含”来描述，改文案时不要写成“上一档包含下一档”。

## 配置项语义

| 键 | 默认 | 说明 |
|----|------|------|
| `levels` | `{}` | 级别表，键名任意（本仓库用 `no-access`/`workspace-edit`/…），值里 `preset` 建立与预设的绑定 |
| `presetLevels` | `{}` | 没写 `preset` 时，用预设 id 找级别表键的映射 |
| `defaultLevel` | `none` | 预设匹配不到任何级别时的兜底；**未识别的值一律收敛到全拒** |
| `treatReadOnlyAsNoAccess` | `true` | 把 `read-only` 沙箱模式当作无权限（本仓库配置里显式关掉，因为 `workspace-access` 的沙箱也是 `workspace-write`，但这里指的是从 sandbox 反推权限的老路径） |
| `opaquePolicy` | `directory` | opaque 命令按运行目录判定；`deny` 则一律拒 |
| `allow` | `[]` | 读白名单种子（`/access-allow add` 的初始值），重载插件即丢 |

解析优先级：命中级别表键 → 命中 `presetLevels` → `treatReadOnlyAsNoAccess` → `defaultLevel`。
**永远不从沙箱模式反推权限**——那是另一套语义，混在一起会出现“改了沙箱，权限跟着变”的隐性耦合。

## 委派会话的写切片

派发子任务时，父会话可以在首条用户消息里写一行注释声明本任务的写入范围：

```html
<!-- dsh-access-scope: {"write": ["src/"]} -->
```

子会话继承父会话的级别与授权，但写的一半被收窄到这个列表：越界写直接拒绝（`[access: 越界写入]`），不弹授权页——因为派发者已经把这个 run 限定住了，再问用户等于把边界推翻。

只认 `user/message` 上的标记：assistant 消息或工具输出里出现的同名注释不算声明。

## 已知的宿主侧陷阱

宿主的 `permissionPresets.derive(state)` 在 `state.preset` 失配时会扫预设表取**第一个** `sandbox`+`approval` 相同的项。历史上 `no-access`、`workspace-access`、`read-only` 三者的 `(read-only, ask)` 完全相同，导致“预设丢了就显示成无权限”。
现在三档的沙箱分别是 `read-only` / `workspace-write` / `read-only`，只剩 `no-access` 与 `read-only` 撞车；真要区分，只能保证 `state.preset` 不丢。
