# 公共契约（本轮冻结）

任何子代理改代码前必须先读这份文件。契约变了要由集成负责人改，代理不能自己动。

## 1. 检索结果结构

`recall(cfg, query, deadline)` 返回 `RecallHit[]`，每条至少包含：

| 字段 | 类型 | 含义 |
|---|---|---|
| entry | object | 命中的记忆条目（含 id / text / fact / source_id） |
| score | number | 时间衰减后的排序分，**排序只看这个** |
| queryScore | number | 原始查询贡献 |
| expansionScore | number | 扩展候选分，未截断 |
| effectiveExpansionScore | number | 实际加进总分的扩展分 |
| preDecayScore | number | queryScore + effectiveExpansionScore |
| queryMatched | number | 原始查询命中的 2-gram 数 |
| expansionMatched | number | 扩展命中数 |
| coverage | number | queryMatched / 原始 gram 总数，恒在 0–1 |
| weight | number | 时间衰减权重 |

恒等式：`preDecayScore === queryScore + effectiveExpansionScore`，任何改动都不能破坏它。
测试在 `test/score-contract.test.mjs`。

## 2. 状态语义

`active` / `superseded` / `archived` / `draft`。缺 status 字段视为 legacy，可召回。
`superseded` 和 `archived` 不进候选池，**在任何通道都不能复活**。
状态表损坏时按 conservative 处理（宁可少召回，不可召回已被取代的）。
权威实现在 `status.mjs`，其他模块不许自己判断状态。

## 3. 文件所有权

| 文件 | 所有者 |
|---|---|
| `index.js` | **只有集成负责人**（主代理）能改 |
| `syn.mjs` | 检索扩展代理 |
| `abstain.mjs`（新建） | 拒答代理 |
| `lib/*.mjs`（新建） | 各自创建者 |
| `scripts/benchmark-latency.mjs` | 性能代理 |
| `test/fault-injection.test.mjs`（新建） | 测试代理 |
| `status.mjs` / `config.mjs` / `fs-safe.mjs` | 本轮冻结，只读 |
| `test/fixtures/**` | 本轮冻结，只读 |

代理只能改自己那一行对应的文件。要改别人的，先在回复里提出来，不要动手。

## 4. 评测口径

- `scripts/quality-eval.mjs`（12 条）是**开发集**，可以边改边跑。
- `scripts/quality-frozen.mjs`（157 条）是**冻结集**，只用来观察基线，**不许为了让它变绿去改语料或调参**。
- 当前冻结基线：Recall@1 48.1% / Recall@3 49.6% / MRR 0.489 / 无答案误召 8.3%。

## 5. 证据判定与注入

`recallWithVerdict(cfg, query, deadline)` 返回：

| 字段 | 类型 | 含义 |
|---|---|---|
| hits | RecallHit[] | 与 `recall()` 返回值完全一致的候选 |
| verdict | 'answer' \| 'ambiguous' \| 'abstain' | 证据够不够拿出来用 |
| evidenceStrength | number | **启发式**证据强度，0–1 |
| confidence | number | 同值别名，只为兼容保留，新代码用 evidenceStrength |
| reason | string | 判定理由，来自 `REASON` 枚举 |

`evidenceStrength` **不是校准概率**。0.82 不表示「82% 概率正确」，
它只是覆盖率、命中数、密度的加权组合。文档和代码里都不许把它叫成 confidence 或置信度。

### 注入行为（本契约的目标状态）

`agent/pre-step` 的注入路径必须读 verdict，不能只看 `hits.length > 0`：

| verdict | 注入行为 |
|---|---|
| answer | 正常注入记忆块 |
| ambiguous | 按明确设计降级呈现（标注歧义，不伪装成确定答案） |
| abstain | **不注入**任何候选 |

判定逻辑只允许来自 `abstain.mjs`。注入路径不许再手写一套自己的规则。

判定与注入必须一起记进日志：verdict、reason、耗时、是否注入。

### 当前状态（未达成，别当成已有）

`index.js` 第 945 行的注入路径仍直接调 `recall()`，只判断 `hits.length`。
上面的注入表是**待实现的目标**，不是现状。集成完成前不要在文档里写成已完成。

## 6. 硬性规则

1. 不许为了指标好看改冻结语料或删失败样例。
2. 不许把 `recall` 的返回结构改得不兼容。
3. 新增依赖必须零运行时依赖（项目现在是 0 依赖，不要破坏）。
4. 改完必须跑 `node scripts/quality-frozen.mjs` 并报告前后数字。
5. 报告里没跑过的命令，不许说跑了。
