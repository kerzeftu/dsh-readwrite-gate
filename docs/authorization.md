# 授权流程与授权存储

## 什么时候弹页

只有一种情况：**某一族的 scope 是 `workspace`，而这次调用要碰的路径里有落在工作区和临时区之外的**，且该路径没有被本对话的授权覆盖，也没有被读白名单命中。

弹页是逐族的：一次 `cp /etc/passwd ./x` 里“读 `/etc/passwd`”和“写 `./x`”分开判定，只有区外的那一半会问。

## 三个选项

| 选项 | 记录什么 | 后续影响 |
|------|----------|----------|
| 不允许（`deny`） | 什么都不记 | 本次调用被拒；下一次越界重新问 |
| 仅一次（`once`） | 什么都不记 | 本次放行；下一次同类越界重新问 |
| 该对话中总是可以访问 / 总是可以修改（`always`） | 把**本次请求的路径**记入本对话的额外路径（读写分族） | 该路径及其子目录不再询问，可在面板里撤销 |

第三项的标签按族变化：读是“该对话中总是可以访问”，写是“该对话中总是可以修改”。“允许访问”不等于“允许修改”，反之亦然——两条授权互不派生。

## 路径怎么记

`grantTargetsOf(kind, paths, operation)` 决定“这次授权覆盖哪一行”：

- 如果路径本身就是本次操作的目标目录（`targetDirs` / `writeDirTargets`），记目录；
- 否则记它所在的目录（`directoryOf`）。

所以授权 `/etc/hostname` 实际记的是 `/etc/`。这是刻意的：用户点“总是”时想表达的通常是“这个目录别再问了”，按单个文件记会导致同目录下一个文件又问一次。
代价是授权粒度偏粗，撤销时要按行撤（面板每一行都可 ✕ 掉）。

行里带 `directory: true` 时显示尾斜杠，语义是“覆盖其下全部内容”。

## 授权存在哪、什么时候失效

- 存在 Harness 进程内存：`liveGrants[sessionId] = Map<path, { read, write, directory }>`。
- **会话销毁**（`session/disposed`）时清空；**agent 重建**（`agent/disposed`）不清——早期在 agent 销毁时清，导致“撤销过的授权复活”。
- **重启 Harness 全部丢失**，下次越界重新询问。这不是缺陷而是取舍，见 [decisions/0003](decisions/0003-conversation-scoped-grants.md)。
- 派发子会话（`header.parentSession`）继承父会话的实时授权：父会话在子会话存活期间授权的路径，子会话立刻可见；反之不继承。

## 授权页与问题服务

授权页用的是宿主的问题服务，不是 `ask_user_question` 工具：

```js
await ctx.userQuestions.ask({ agent, signal, questions: [{
  id: grantQuestionId('dsh-access-permission/', kind, dirs),
  header: kind === 'write' ? '请求修改授权' : '请求访问授权',
  detail: […],
  options: DIALOG_OPTIONS…,
}] })
```

- 问题 id 里编码了族与路径：`dsh-access-permission/<kind>|<encodeURIComponent(paths.join('\x01'))>`，由 `grantQuestionId` / `parseGrantId` 互转。
- 回答按标签或 value 归类（`answerOf`），允许自定义文本回答“不允许”这类中文标签。
- 会话被销毁或 `signal` 取消时，`ask` 抛错 → 视为 `unavailable`，调用被拒（fail closed）。

因为走的是服务而不是工具，**答案不会写进会话日志的 `tool/call` 记录**，`readGrants()` 的日志回放对本插件是空转。保留它只是为了兼容曾经用工具弹页的版本与委派继承的历史路径，不要依赖它。

## 撤销

撤销有三个入口，效果一致：

- 面板里点某一行的 ✕：读框 ✕ 会同时撤读与写（写行在被撤销时连写一起撤），写框 ✕ 只撤写。
- `remove <path>` / `remove-read <path>` / `remove-write <path>`。
- `clear`：清空本会话的额外路径。

撤销改的是内存里的那份 `liveGrants` / `readAllow`，下一次同类访问会重新弹页。

## 写到区外会怎样

授权页回答“允许修改”后，调用会真的执行，然后被平台沙箱拒绝（因为预设的 sandbox 是 `workspace-write`）。
模型看到的是沙箱错误，而不是插件错误。这是刻意的：插件不应该替沙箱做决定，也不应该假装自己能做到沙箱禁止的事。

## 读白名单（`add` 出来的行）

`/access-allow add <path>` 往 `readAllow` 写一行读白名单，它的优先级**高于级别**：即使当前是无权限，这一行也允许读取。这是“运维显式例外”的语义，和对话框授权不同（对话框授权在级别判定之后）。

白名单只允许读，不允许写；`add-write` 走的是对话授权那条路。
