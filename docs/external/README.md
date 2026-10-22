# 外部取经：合并结论

三份分档报告（[A](A-layered-and-capture.md) / [B](B-storage-and-decay.md) / [C](C-audit-and-tooling.md)）覆盖 12 个竞品仓库，全部 clone 到 `projects/_ext/` 后读源码，结论带 `文件:行号`。
这份文件只做一件事：**从 27 条建议里筛出真正该进代码的，其余明确写成"不做"。**

## 一、先看体量，再看设计

| 项目 | 代码量 | 运行依赖 | 工具数 | 有衰减 |
|---|---|---|---|---|
| hindsight | ~31 万行（engine 单文件 24,348） | 53 个 py 包 | — | **无**（遗忘=显式 invalidated） |
| dsh-tiddlywiki | ~7.3 万行 | 1 | 16 | 无（valid-until 声明） |
| dsh-prime-memory | 45,962 行 / 140 文件 | 5（含 sqlite-vec、jieba 原生） | 19 | 有（地板 0.5） |
| dsh-mnemon | 29,931 行 / 622 文件 | 22 + React peer | 视图式 | 无 |
| memory-eternal | 13,232 行 / 116 文件 | 1（硬依赖 node:sqlite） | 10+ | 无 |
| dsh-meow-memory | 七层 SQLite | 0 | — | 有（9 段分桶） |
| dsh-auto-memory | 3,170 行 / 12 文件 | 2 | 6 | 有（0.995^天） |
| dsh-soul-md | 2,707 行 / 14 文件 | 1 | 6 | 无 |
| **dsh-memory-core（我们）** | **5,911 行根级** | **0** | 少量 | 有（半衰期 30 天） |

结论：**我们的体量已经在第一梯队，问题不是"缺功能"，是"别长成它们"。**

## 二、值得进代码的只有 6 条（按优先级）

### P0 · 各 ≤5 行，都是已实测的缺陷

| # | 动作 | 落点 | 证据 |
|---|---|---|---|
| 1 | 裁剪循环 `break` → `continue` | `summary.mjs:416` | 我们现在 `if (used + line.length + 1 > room) break`——**一条超长单行会把它之后所有条目挤出注入**。auto-memory 明确写过这是审查确认的单行 DoS（`prompt.ts:100-108`） |
| 2 | 截断即引流 | `summary.mjs:430` | 现在是裸 `text.slice(0, maxChars)`。prime-memory 把后缀当契约：`…(已截断；可用 memory_search 查看详情)`（`recall-budget.ts:11-12`）。截断不是损失，是指路 |

### P1 · 各 20–60 行，有明确收益

| # | 动作 | 落点 | 证据 |
|---|---|---|---|
| 3 | 召回结果带 `reasons[]`（命中词 / affect / 衰减各一项） | `syn.mjs` | Culeot/dsh-memory 的可解释打分。排查"为什么召回到这条"时不用重跑 |
| 4 | 压缩后回捞：监听 compaction，把本会话读过的 topic 在压缩后重新注入 | `index.js` | soul-md `:250-277`。长会话"刚查过就忘"的解药，我们没有 |
| 5 | 审计只记状态迁移（path, old→new, changed_by, reason） | `fs-safe.mjs` | memory-eternal `audit_log`。约 20 行，比全量快照便宜得多 |

### P2 · 想清楚了再做

| # | 动作 | 落点 | 代价 |
|---|---|---|---|
| 6 | 审阅态物理隔离：JSONL 拆 `approved.jsonl` / `pending.jsonl`，召回只开前者 | `fs-safe.mjs` | eternal 的理由很硬（"一张表+status 列"漏写了三处 WHERE），但我们已有 status 过滤 + supersedes 优先，收益是"漏判变成读不到" |
| 7 | 软淘汰：超期且零引用只隐藏不删，permanent 免疫 | `decay.mjs` + `summary.mjs` | auto-memory `store.ts:293-297`。我们已经 permanent 免疫 + 半衰期，加的是"隐藏"这个中间态 |

**注意**：第 1、2 条属主逻辑文件 `summary.mjs` 的改动，按本轮"外围整理"的约定**没有实施**，等批准。

## 三、明确不做（这比抄什么更重要）

| 不做 | 出处 | 理由 |
|---|---|---|
| L0–L3 分层蒸馏 | prime-memory | 46k 行 + 2 个原生依赖换来的分层，边界干净但代价是 8 倍体量 |
| 七层表 / SQLite | meow-memory、eternal | meow 实测**全仓 0 个 `CREATE INDEX`**，七张表共享同一套列只差 4 个字段——按"谁读它"分表是负债不是设计；eternal 硬依赖 node>=22 且无 JSONL 回退 |
| 向量 / embedding / 多臂 RRF | hindsight、prime、Veyra | 我们 21KB 档案上 BM25-lite 已 recall@3=1.0。RRF k=60 是为多路不可比分数设计的，单路用不上 |
| provider 总线 | mnemon | 22 个依赖，且**它自己根本没有统一打分器和衰减**——解决的不是我们的问题 |
| wiki 层 | tiddlywiki | 它是知识库不是记忆库；与我们的 docs+memory 双轨在存储上重复 |
| 19 个工具 / 管理工具 | prime、auto-memory | `memory_prune`/`memory_delete_all` 这类对我们是纯负担 |
| 双轨兼容层 | soul-md、meow | 我们还没发过版，不为迁移先背上百行兼容代码 |
| settings YAML 装整段 markdown | soul-md | 每次读配置都带人设正文 |

## 四、"小巧精致"的硬指标

以后加任何机制，先过这张表；过不了就写进本文件的"不做"清单，不写进代码。

| 指标 | 上限 | 当前 |
|---|---|---|
| 根级模块数 | 8 | 14 个 .mjs + index.js/client.js |
| 根级代码行数 | 6,500 | 5,911 ✅ |
| 运行时依赖 | 0 | 0 ✅ |
| 注入给模型的工具数 | ≤5 | 待核 |
| 单条注入长度 | ≤500 字符 | 500 ✅ |
| 单次注入总量 | ≤2,000 字符 | 待核 |
| 新机制必须能落在现有 5 个模块内 | 硬性 | — |

**一条底色**：12 个竞品里，衰减做得最好的（meow、prime、StrataGate）都只需要 60–90 行；做不好衰减的那些，问题从来不是衰减算法，是存储和分层。
