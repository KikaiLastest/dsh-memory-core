
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
