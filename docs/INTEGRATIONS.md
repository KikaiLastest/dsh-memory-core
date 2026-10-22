# 接入说明（abstain / 身份 / 状态过滤）

三篇接入文档的合并稿：答案证据与弃答、捕获副本的内容身份、状态过滤的接入时机。三者是同一条「内容身份」主线的三个切面。

## 一、弃答（abstain）接入


# 注入路径接入 verdict：实施说明

> 作者：拒答代理（agent-3）。读者：集成负责人（唯一可以改 `index.js` 的人）。
> 本文只给方案与实测数据；`index.js` 一行没动。新增的 shadow 测试在
> `test/abstain-preflight.mjs`，只改 `abstain.mjs` 与它自己的测试。

## 1. 缺口在哪

`index.js` 的 `agent/pre-step`（约 945 行）现在直接调 `recall()`：

```js
const hits = recall(cfg, query, started + cfg.timeoutMs)
if (!Array.isArray(hits) || hits.length === 0) { /* 不注入 */ }
// hits 非空 —— 无条件 buildBlock + 注入
const text = buildBlock(hits)
```

`recallWithVerdict()`（约 530 行）已经算出了 `verdict / reason / evidenceStrength`，
但主路径没用它。所以「覆盖率 0.11、靠回退通道硬凑出来的候选」和真命中长得一样，
都会被注入成看着很像样的假答案。这正是评审说的 P0。

**注意一个结构事实**：`decide()` 的证据线和 `recall()` 的严格通道同口径
（`minCoverage` / `minMatched`）。所以当前实现下：

> `verdict === 'abstain' && hits.length > 0` ⇔ 这些 hits 全部来自回退通道。

严格通道回来的 hits 一定过得了证据线。这不是巧了，是设计：回退通道本来就是
「尽力想起来」，它的产物必须被下游标成不可信。以后检索代理如果改了回退规则，
这个等价关系会松，但不影响下面的接法——用 verdict 判断，不要去嗅通道。

## 2. 实测数据（157 冻结集 + 12 开发集）

命令：`node scripts/quality-frozen.mjs`（基线原样复核，见 §6）。
判定数据：用同一份冻结语料装载，把 `recall` 换成 `recallWithVerdict` 逐条重放
（脚本片段见附录，未入库）。**没有改任何语料、夹具或阈值。**

| 指标 | 数值 |
|---|---|
| 冻结集 verdict 分布 | abstain 82 / answer 70 / ambiguous 5 |
| 当前会注入的块 | 75（73 条有答案查询 + 2 条无答案误召） |
| 含正确答案的查询被 abstain 误伤 | **0 / 66**（64 条 top1 正确里 0 条） |
| 有 hits 但 verdict=abstain | 4 条，全部是回退通道 |
| 这 4 条里含正确答案的 | **0** |
| 无答案误召被 abstain 拦住 | **0 / 2** |
| `evidenceStrength` 区间 | answer 0.393–1；ambiguous 0.273–0.495（重叠） |

4 条「有 hits 但 abstain」的形态完全一致：`matched=1`、`expansionMatched=1`、
`coverage=0.10–0.14`、单条、`score=5.52`。它们都是把「服务现在跑在哪台机器上」
骗去召回「服务端口」条目——语义无关，但「服务」这个 2-gram 确实重合。
其中 0 条含期望答案。

2 条无答案误召则相反，证据很足：

| 查询 | 匹配到的条目 | coverage / matched / score | verdict |
|---|---|---|---|
| 备份用的移动硬盘是什么牌子的 | 备份策略（移动硬盘……） | 0.333 / 4 / 13.45 | answer |
| Python 的 GIL 怎么绕过 | 代码风格又改了（……用的是 Python） | 0.417 / 5 / 13.14 | answer |

正确答案 top1 的特征范围是 `coverage 0.20–0.75 / matched 2–11`，和这两条**完全重叠**。
把 `matched>=3` 会误杀 24 条正确答案，`coverage>=0.3` 会误杀 19 条。
所以：**abstain 用现有特征分不开这两条误召，接上 verdict 不会让 8.3% 的无答案误召下降。**
不要拿「接 verdict」去承诺这个指标，这两条要等检索层加否定证据/语义匹配。

**开发集的代价（必须知道）**：12 条（9 有答案 / 3 无答案）里，
「服务跑在什么环境上」「部署在什么机器上」两条 top1 就是正确答案，
但走的是回退通道（`matched=1`），`decide()` 判 `weak-matched`。
也就是说：

> **硬门（abstain 直接不注入）在开发集上把「能拿到正确答案」的查询从 9 条砍到 7 条
> （100% → 77.8%），在冻结集上一条正确答案都不砍。**

开发集样本小、且此前已确认过拟合，所以这只能当「代价观察」，不能当收益证据；
但它说明回退通道偶尔真的能救回正确答案，硬门不是免费的。

## 3. 推荐方案：分三阶段，不要一步到位

### 阶段 0（建议先做）：shadow，只打日志

把 `recall(...)` 换成 `recallWithVerdict(...)`，用 `v.hits`，**注入行为一行不改**，
只在 `appendLog` 里多记三个字段。零行为风险，先收集真实使用中的 verdict 分布。

```js
const started = Date.now()
const v = recallWithVerdict(cfg, query, started + cfg.timeoutMs)
const hits = v.hits
// …hits 空则照旧返回…
appendLog(cfg.logFile, {
  at: new Date().toISOString(),
  query: query.slice(0, 80),
  hits: scored,
  ms,
  injected: true,
  verdict: v.verdict,
  verdictReason: v.reason,
  evidenceStrength: v.evidenceStrength,
})
```

字段命名建议：新字段用 `verdict` / `verdictReason` / `evidenceStrength`。
**不要复用现有 `reason`**——它已经被 `too_short` / `dedup` 占用，语义是「没注入的原因」。

### 阶段 1（推荐落地）：soft gate，注入但加不确定框架

证据线没过的块照旧注入，`buildBlock(hits, verdict)` 在头部多一行：

```
以下为自动召回的历史记忆，不是用户本轮发言，仅作参考。
（系统对这些内容没有把握，可能是误命中，请核对后再采信。）
```

这是真正解决 P0 的做法：**伤害不是「注入了」，而是「看着像定论」**。
它保留开发集那 2 条正确线索，同时杀掉「硬凑出来的假答案」伪装。
`buildBlock` 是 `index.js` 内部函数，需要集成负责人改；`abstain.mjs` 不用动。

`ambiguous` 建议在 soft 阶段加另一行（「候选不唯一，别当定论」）；
阶段 0/2 都按「照旧注入」处理即可，不要和 `abstain` 混为一谈。

### 阶段 2（可选）：hard gate，abstain 不注入

如果产品决定「宁可不说，也不给可能错的线索」，再上硬门。落点：

```js
// 位置必须在 seen.add / buildBlock 之前，避免占掉 seen 名额
if (v.verdict === 'abstain') {
  appendLog(cfg.logFile, {
    at: new Date().toISOString(),
    query: query.slice(0, 80),
    hits: scored,          // 仍然记录被拒的候选，方便审计
    ms,
    injected: false,
    reason: 'abstain',
    verdict: v.verdict,
    verdictReason: v.reason,
    evidenceStrength: v.evidenceStrength,
  })
  return decision
}
```

要点：

- 不要把 `key` 写进 `seen`：没注入的查询以后还应该有机会重新注入；
- `hits` 仍然记进日志（上面已给出），否则线上没法回看「当时拒了什么」；
- 现有 `seen` 去重键（query + hit ids）不用改；
- 成本：`decide()` 对 ≤ topK 条排序，O(k log k)，无 I/O，不影响 150 ms 预算；
- 异常：`recallWithVerdict` 抛错保持现有 `try/catch` → 返回原 decision（best-effort 不变）；
- 开关：`config.mjs` 本轮冻结，**不要加配置项**。要开关就在 `index.js` 里放模块常量
  （例如 `const ENFORCE_ABSTAIN = false`），默认 shadow，翻常量才上硬门。

## 4. 明确不要做的事

1. **不要用 verdict 改 `hits`。** `recallWithVerdict` 的契约是 hits 与 `recall()` 完全一致
   （`test/verdict-e2e.test.mjs` 有断言）；要过滤就在注入组装前做，别在召回层做。
2. **不要拿 `evidenceStrength` 当概率。** 权重是手写的，没有任何标注数据拟合过；
   而且跨 verdict 不可比（answer 可以低到 0.393，ambiguous 可以高到 0.495）。
   展示时只显示分档（如 低/中/高），并且必须和 verdict 一起显示。
   字段名就叫 `evidenceStrength`，不要叫 `confidence`（旧别名已从 `decide()` 删除）。
3. **不要为了拦住那 2 条误召去抬 `minCoverage` / `minMatched`。**
   实测会误杀 19–24 条正确答案，且违反「不许为了指标好看调参」。
4. **不要把 `ambiguous` 当 `abstain`。** 它证据线已经过了，只是分不出主次；
   吞掉它等于凭空降低召回。

## 5. 验收

新增 shadow 集成测试：`test/abstain-preflight.mjs`（本次交付）。

```bash
node test/abstain-preflight.mjs
```

它用真实 `apply()` 注册真实 pre-step，再叠加 verdict 门，断言：

- `answer` → 照旧注入，注入正文包含命中内容；
- 回退通道弱候选（原始命中 1 个、扩展 1 个）→ `abstain(weak-matched)` → **不注入**；
- 无命中 → `abstain(no-hits)` → 不注入（与旧行为一致）；
- shadow 用的 hits 与主路径 `recall()` 完全一致（契约）；
- `ambiguous` → 继续注入（策略表固定）。

测试里有一行 `console.log('... current pre-step injected = true')` 是给阶段 0/2 的观察点：
**上硬门之后可以把它升级成 `assert.equal(s.injectedBefore, false)`**，那时测试才真正锁住主路径。

回归命令（数字不应变化，因为门不改召回）：

```bash
node scripts/quality-frozen.mjs   # 对照 BASELINE.md 的「当前值」一节，不要用本文件写死的数字
npm test
```

`package.json` 的 test 链不在我的文件范围内，请集成负责人把
`node test/abstain-preflight.mjs` 加到 `test/verdict-e2e.test.mjs` 之后；
不加的话这个测试只能手动跑。

## 6. 已知限制 / 未决问题

- `decide()` 只对 **top1** 做硬判定；rank>1 的可信度依赖 `recall()` 严格通道同口径。
  当前实测「top1 过线但 rank2/3 单独会被拒」的块是 0 例，但这是跨模块不变式：
  检索代理放宽严格通道时，这里会一起松。
- `expansion-only` 这条硬规则在当前 `recall()` 下不可达（回退要求 `coverage>=0.1`，
  等价于 `queryMatched>=1`）。保留它是给其他 hit 生产者/未来通道的防御，不是死代码。
- 语义型误召（第 2 节那两条）无法用现有特征区分；要解决得在检索层加否定证据/实体匹配。
- `evidenceStrength` 未校准，且没有标注集；想做成可比较的分档需要单独做校准，本轮没做。
- 冻结集数字是「观察基线」，不是门禁；本文所有数字都来自当前分支的实测（见 §2）。

## 附录：重放冻结集 verdict 的脚本片段

放到 worktree 外的临时文件里跑（不要提交），依赖与 `scripts/quality-frozen.mjs` 相同的装载逻辑：

```js
const cfg = { memoryRoot, dialogueFile, structuredFile, topK: 3, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30 }
for (const c of cases) {
  const r = recallWithVerdict(cfg, c.q, Date.now() + 5000)
  const texts = r.hits.map((h) => h.entry.text)
  const rank = c.expect === null ? -1 : texts.findIndex((t) => t.includes(c.expect))
  // 统计 r.verdict / r.reason / r.evidenceStrength / rank / r.hits.length
}
```

未跑过的命令本文不写；第 2 节每个数字都有对应的实际输出。

## 二、身份（identity）接入


> 范围：只解决「正文已标记 superseded，但自动捕获副本仍被召回」。
> 不改变 status.mjs 的判定权；autocapture.mjs 只负责把身份变得可解析。
> 集成前本文件不生效：index.js 仍只把捕获记录投影成 `{id,src,line,text,...}`。

## 1. 规范身份

- `canonicalBody(text)`：统一 CRLF、去首尾空白、去掉第一行 Markdown 标题；正文内部不动。
- `bodyId(text) = idOf(canonicalBody(text))`：同一段正文的原文/摘要/捕获副本共用的**正文身份**。
- `captureContentId(record)`：显式 `contentId` → 落盘 `bodyId` → 现算 `bodyId(text)`。
- `linkCaptureToSource(record, candidates)`：在 `src === 'dialogue'` 的候选里按「去空白后的正文包含关系」找出处，回填
  - `contentId = idOf(整节原文.trim())`（structured.jsonl 的 `id`）
  - `sourceId = entry.sourceId || entry.id`（`dialogue:行号`）
- `toCaptureEntry(record, candidates)`：index.js 读取侧的投影函数，输出和原对象字面量同形，另带 `contentId/sourceId`。

为什么是两层：状态表目前只认 `idOf(整节原文)`（consolidate.mjs:83），摘要也用同一套（summary.mjs:530）；捕获文本只是小节正文的一部分，单靠正文哈希查不到表。正文哈希是**匹配键**，整节哈希是**状态键**。

## 2. 落盘字段

`autoCapture` 现在会在每条 JSONL 里写：

```json
{
  "id": "cap-...",
  "text": "捕获正文",
  "contentId": "mem-...",
  "bodyId": "mem-...",
  "sourceId": null,
  "type": "auto_capture",
  "weight": 1,
  "created_at": "...",
  "source": "dialogue"
}
```

- 不传 `contentId` 时 `contentId = bodyId = idOf(canonicalBody(text))`，保证每条捕获都自带正文身份。
- `sourceId` 只有调用方确实知道坐标时才写，不知道就写 `null`，不猜。
- 旧记录没有这两个字段也能读；`captureContentId` 会现算。

## 3. 集成点（index.js，基于 76a81fc）

### 3.1 唯一必需改动：读取侧

- 文件：`index.js`
- **第 7 行** import 加 `toCaptureEntry`：

```diff
- import { autoCapture, readCaptureStore } from './autocapture.mjs'
+ import { autoCapture, readCaptureStore, toCaptureEntry } from './autocapture.mjs'
```

- **第 143-155 行**，把 `for (const c of captured) { ... entries.push({...}) }` 整段替换为：

```js
    for (const c of captured) {
      if (c && c.text && c.text.length >= 5) entries.push(toCaptureEntry(c, entries))
    }
```

- 插入点必须在 dialogue 条目已经 push 之后（当前就是）；传的是捕获循环开始前的 `entries`。
- 不需要改 `loadEntries` 的其他地方；`toCaptureEntry` 对无 text 的输入返回 null，已有 if 会挡掉。

### 3.2 可选：写入侧带坐标

当前 `agent/pre-step` 只有用户消息文本，不知道未来会落到对话文件哪一行，所以 **autoCapture 调用处不需要改**。若上游以后能拿到坐标，可加：

```js
autoCapture({ ..., sourceId: 'dialogue:123', contentId: idOf(sectionText) })
```

有 `sourceId` 时，即使正文后来被轻微编辑，也还能按坐标查状态；这条不在本次默认路径里。

## 4. 集成后如何验证「正文 superseded → 捕获副本不再召回」

### 4.1 跑回归

```bash
node test/identity-capture.test.mjs
```

断言链：

1. `captureContentId(record) === idOf(同一段正文)`；
2. 原文 / 摘要 / 捕获三个副本的 `resolveEntryStatus(..., statusMap)` 都等于 `'superseded'`；
3. `filterRecallableEntries([linked], statusMap).recallable.length === 0`，且 `suppressed === 1`；
4. 新方案（active）的捕获副本仍可召回，证明不是一刀切；
5. 未接身份的旧投影 `resolveEntryStatus === null` 且 `isRecallable(null) === true`，复现缺陷前提，证明接入不是摆设。

> 本分支按约束没有改 `package.json`。集成者需在 `scripts.test` 链里加
> `node test/identity-capture.test.mjs`；在接进主链之前，`npm test` 会因
> `pack.test.mjs` 的「每个 test/*.test.mjs 必须被 npm script 引用」检查而红，
> 单独跑该文件是绿的。

### 4.2 真实召回

构造或复用临时档案后：

```js
import assert from 'node:assert'
import { recall, invalidateMemoryCache } from './index.js'

invalidateMemoryCache()
const hits = recall(cfg, '旧缓存方案')
assert.ok(!hits.some((hit) => hit.entry.text.includes('旧的缓存方案')), '淘汰正文的捕获副本不得再召回')
```

观察点：候选池里该捕获条目的 `contentId` 应等于 structured.jsonl 里旧记录的 `id`，`sourceId` 应等于它的 `source_id`；若仍是正文哈希或 null，说明 `toCaptureEntry` 没接上，或候选里没有对应的 dialogue 条目。

## 5. 这个方案没有解决什么（明确边界）

1. **捕获正文被编辑 / 改写**：识别不出。`bodyId` 按落盘文本计算；用户把捕获副本改一个字，或原文被改写后不再是逐字子串，包含匹配失败，`contentId` 回落到正文哈希，状态表查不到 → 仍可能被召回。没有原文坐标就无解；要么禁止编辑捕获文本，要么写入时带 `sourceId`。
2. **原文小节被删除**：识别不出。候选池里没有 dialogue 小节可接，正文哈希也查不到以整节哈希为键的旧状态表 → 仍可能被召回。需要 status.mjs / consolidate 增加「正文哈希 → 状态」索引，或写入时带 `sourceId`。
3. **标题改动 + 行号漂移**：本方案只保住正文哈希匹配，仍接不回旧状态键。新标题算出新整节哈希，新行号也不在表里，`resolveEntryStatus` 返回 null；红队缺陷 #2 仍未解决，需要 consolidate/status 用正文哈希建状态索引（或迁移旧表）。
4. **一段正文被多个小节包含**：取正文最短的那个，仍有误接风险（可能接到另一个含同一句话的小节）。没有唯一约束或坐标时不保证正确。
5. **脱敏改变文本**：`sanitize` 把密钥替换后，`bodyId` 与原文正文不同，包含匹配可能失败；安全优先，接受不接。
6. **旧捕获记录**：只有文本逐字是原文子串时能接；否则同第 1 条。
7. **index.js 未接入时**：落盘字段本身不拦截任何东西；4.1 第 5 条会打印泄漏路径。这是预期，本文件就是集成说明。

## 6. 回滚

- 回滚 index.js 的一行调用 + 还原 autocapture.mjs；新增字段对旧读取端无害（index.js 不读就忽略）。
- 已落盘的 `contentId/bodyId/sourceId` 不用删，不影响旧代码。

## 三、状态（status）过滤接入


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
