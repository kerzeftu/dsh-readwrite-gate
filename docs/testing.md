# 测试

## 两处测试，各管一半

| 位置 | 内容 | 跑法 |
|------|------|------|
| `test/delegation.test.mjs` | 随包测试：委派继承、写切片、解析边角（`file://`、箭头函数、`2>&1`） | `node test/delegation.test.mjs` |
| `/home/kerze/.access-permission-selftest/` | 开发期六套自检，覆盖宿主行为、界面、座位、文档一致性 | `node check-*.mjs` |

六套自检是开发资产，不在 npm 包里（依赖宿主 checkout 与测试桩）。

## 六套自检各测什么

| 脚本 | 断言的层次 | 典型内容 |
|------|------------|----------|
| `check-locale.mjs` | 源码级 | zh/en 字典键集合一致、用到的键都能解析、档位与确认弹窗文案与宿主原版一致、座位注册存在 |
| `check-panel.mjs` | 组件渲染 | 两框结构、计数、空态、行标记、按钮接线（用假 React 渲染真实组件） |
| `check-menu.mjs` | 组件渲染 | 菜单五行、顺序、选中态、切换调用、加号菜单入口的 `available()` |
| `check-visual.mjs` | 源码 + 渲染 | 五档配色、字体几何、材质 token、图标字形、hook 顺序、请求代次、`inject` 声明 |
| `check-gate.mjs` | 行为级 | 直接 import 真 `index.js`，用假 ctx 驱动 `tools/pre-execute`，覆盖读写判定、授权、撤销、继承 |
| `check-seat.mjs` | 规则级 | 复刻宿主 slots 的 `single` 座位规则，验证 `priority: -1` 接管与 inject 两条路径 |

跑法：

```bash
cd /home/kerze/.access-permission-selftest
for f in check-locale check-panel check-menu check-visual check-gate check-seat; do
  printf '%-14s ' "$f"; node "$f.mjs" 2>&1 | tail -1
done
```

`check-gate.mjs` 会打印总断言数（当前 284）。`check-visual.mjs` 支持 `AP_CLIENT=<file>` 指定被测客户端文件，负向对照靠它。

## 加断言的规矩

1. **先让它红**。新断言写完后，故意把被锁的行为改坏（或把修复回退），确认断言变红且只有它红；再恢复。
   历史上至少两次出现“测试全绿但功能是坏的”，原因都是断言无法鉴别。
2. `check(label, actual, expected)` 的参数顺序是“名字、实际、期望”。写反了会得到 `expected "…", got true` 这种看不懂的失败。
3. 断言要锁**行为**而不是锁实现细节。比如“无权限下 `cat secret` 被拒”比“`recordWord` 里有 bare 分支”更稳。
4. 涉及 UI 的断言尽量锁几何/材质 token/字形路径，别锁颜色字面量（主题会变）。

## 负向对照记录（当前已覆盖）

| 改动 | 对照结果 |
|------|----------|
| 去掉授权返回后的级别复查 | 1 FAIL |
| 路径不折叠 `..` | 4 FAIL |
| `extractPaths` 恢复为只看顶层 | 1 FAIL |
| 不继承父会话授权 | 1 FAIL |
| 早退移回 hook 中间 | 1 FAIL |
| `inject` 去掉 `sessions` | 1 FAIL |
| 删掉 resize 清理 | 1 FAIL |
| `insideTempArea` 恒 false | 7 FAIL |
| 两档图标换回 | 2 FAIL |

## 已知覆盖缺口

- 宿主真实布局、真实主题变量值：测试用桩，颜色需要真机复核。
- `userQuestions.ask` 的真实交互（超时、取消、多 answerer）：只测了拒绝/超时分支。
- 跨会话并发：`liveGrants` 按 session 隔离，但测试里只有单会话与一个派生子会话。

补缺口的方式：先加一条能复现的断言，再决定要不要改代码；不要为了“覆盖率好看”写不可鉴别的断言。
