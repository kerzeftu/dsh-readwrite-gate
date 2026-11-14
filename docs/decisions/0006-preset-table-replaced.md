# 0006 预设表整体替换 + 级别表双向绑定

- 状态：生效
- 日期：2026-10-10

## 背景

DSH 的 `permissionPresets` 消费者用 `this.presets = config.presets`（整体替换、不与默认表合并），
所以 bundle patch 里的 `presets` 必须写全五档，漏一档就等于删掉一档。
同时插件的级别表要能稳定地把“预设 id”映射到“读写范围”。

## 决策

1. `cordis.patch.yml` 里整体重写五档预设（保留原有三档的语义与 id）。
2. 级别表每一项用 `preset: <预设 id>` 声明归属，**以它为准**覆盖 `presetLevels` 映射，避免两处配置互相打架。
3. `defaultLevel` 全拒兜底：任何失配都收敛到“什么都不给”。

## 后果

- 档位顺序 = `presets` 的键顺序 = 菜单顺序。
- profile 自己的 patch 若也写 `- id: permission`，会遮蔽 bundle 的写入——这是配置合成的语义，不是 bug；
  排查见 [troubleshooting.md](../troubleshooting.md)。
- 升级 DSH 时若默认预设表新增档位，需要手动同步进本插件（因为我们是整体替换）。
