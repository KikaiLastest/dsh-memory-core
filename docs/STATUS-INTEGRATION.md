# 状态过滤接入说明：内容身份与物理位置分离

> 适用：`status.mjs`（本文件与实现同一提交）。
> 结论：**index.js 不需要改动**，现有调用已满足新接口。

## 1. 接口变化（向后兼容）

`filterRecallableEntries(entries, statusMap, options)`：

- 入参不变，index.js:377 的现有调用无需修改；
- 返回对象新增 `driftSuppressed`（被漂移规则拦下的条数），原 `suppressed / unverified / idDrift / legacySuppressed` 保留；
- `idDrift` 语义细化为「坐标撞上记录、但内容身份完全对不上」的条数。旧实现里该分支只在 `status === null` 时统计，而坐标命中时 `resolveEntryStatus` 会直接返回状态，所以它实际上几乎永远是 0。

`resolveEntryStatus(entry, statusMap, options)`：

- 第三个参数可选，默认行为与旧版完全一致（导航等既有调用不受影响）；
- `options.strictIdentity === true` 时启用严格身份：坐标只用于识别漂移，不用于判定状态；
- 新增返回值 `UNVERIFIED_DRIFT`（`'unverified-drift'`），`isRecallable` 对它恒返回 false。

## 2. index.js 精确插入点

**无需插入。** index.js:377 保持原样：

```js
const { recallable, suppressed, unverified, idDrift } = filterRecallableEntries(entries, statusStore, {
  conservative: true,
})
```

原因：严格判定需要的字段 `text / contentId / sourceId / src / line / id`，`loadEntries()` 产出的条目已经全部携带：

- 原文小节（`splitEntries`，index.js:75 起）：`id = <src>:<line>`、`src`、`line`；
- 摘要（index.js:180-192）：`src = 'summary'`、`contentId`、`sourceId`；
- 自动捕获（index.js:145-154）：`src`、`line = 0`、`id = captured-*`，弱身份不套用。

以后新增候选来源时，必须带上 `src` + `line`（原文小节）或 `contentId` / `sourceId`（摘要），否则只能走「未受状态管理 → 放行」的兼容路径。

## 3. 判定顺序（严格模式）

1. `entry.contentId` 命中状态表 → 以该状态为准；
2. `idOf(entry.text)` 命中状态表 → 以该状态为准（与 contentId 冲突时取更严的一侧）；
3. 弱身份（仅原文小节 / 摘要）：正文前 48 个非空白字符（`byBody`）→ 标题指纹（`byFact`）；
4. 坐标命中但第 1-3 层全部失配 → `UNVERIFIED_DRIFT`，不可召回；
5. 全部没命中 → `null`，按未受状态管理处理，保持向后兼容放行。

为什么不会误伤未治理的记忆：

- 状态表不存在 / 为空 → 没有任何弱身份索引，全部放行（回归测试第 4 段）；
- 文件从未固化 → 该文件没有任何记录，正文前缀、标题、坐标都不会命中；
- 文件只固化过个别小节 → 其余小节只要正文前缀和标题都对不上、坐标也没撞上，仍然放行（回归测试第 3 段，锁死「不得整体连坐」）；
- 自动捕获不参与弱身份匹配，不会被一句相同的开场白连坐；
- 摘要只在标题命中时继承状态，符合「摘要代表原文小节」的语义。

## 4. 导航通道（可选，summary.mjs 由集成者改）

summary.mjs:356 的调用目前不传第三个参数，仍是旧语义（坐标兜底）。若要让常驻导航获得同样保护，在 `resolveEntryStatus({...}, statusMap)` 的 `statusMap` 后补第三个参数：

```js
{ strictIdentity: true }
```

改后导航里「内容哈希、正文前缀、标题都对不上，只是坐标撞上记录」的条目会被压掉。本提交没有改 summary.mjs。

## 5. 新测试的登记

`test/status-drift-identity.test.mjs` 需要由集成者加入 `package.json` 的 `test` 脚本（建议放在 `node test/status.test.mjs` 之后）。登记前 `pack.test.mjs` 会按「每个 test/**/*.test.mjs 都必须被某条 npm script 串起来」的规则报红，这是预期失败；单独 `node test/status-drift-identity.test.mjs` 为绿。
