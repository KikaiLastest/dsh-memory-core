# 外部竞品取经 A：分层蒸馏 / 主动联想 / 存储沙箱

三个仓库都 clone 在 `D:/dsh-workspace/projects/_ext/`，源码已读（非 README 转述）。
我们的对照模块（5 个以内）：`autocapture.mjs` 捕获 · `syn.mjs` 召回 · `decay.mjs` 衰减 · `consolidate.mjs` 巩固 · `summary.mjs` 注入摘要（`affect.mjs` 是 store 内的一层状态）。

---

## 1. drscrewdriver/dsh-prime-memory（L0~L3 分层蒸馏）

一句话：**分层边界划得最干净的一份**（L0 消息→L1 原子记忆→L2 场景块→L3 画像，各自成套仓储），代价是 140 个文件 / 46k 行 / 2 个原生依赖 / 19 个工具。

| 7 问 | 结论（含出处） |
|---|---|
| 存储格式 | 四套并存：`records/YYYY-MM-DD.jsonl` 只增不改的事实源（`src/store/l1-snapshot.ts:3`）+ `memory.db`(SQLite，主检索，`src/index.ts:199`)+ `*.memory.md` 人读投影（`src/pipeline/md-sync.ts:162`）+ 旧 `l1/records.jsonl` 一次性导入后改名 `.imported`（`l1-snapshot.ts:133,167`） |
| 捕获时机 | 单点 `ctx.on('session/event')`（`src/hooks/capture.ts:140`），只认 5 类事件（`capture.ts:55-61`），按会话缓冲上限 500 条（`capture.ts:67`），**turn/end 时成批落盘**（`capture.ts:167-170`） |
| 蒸馏触发 | 阈值爬坡：生效阈值 1 起步、每成功一次翻倍至稳态（`src/pipeline/trigger.ts:12-22`）；默认 `minMessages=6`、`idleSeconds=300` 兜底（`src/config.ts:587-588`）；L2 每族累计 `minNewMemories=5`（`config.ts:594`）；L3 每 `interval=20` 条（`config.ts:600`） |
| 召回打分 | 三策略 keyword(FTS5 BM25)/embedding/hybrid=双路 **RRF k=60**（`src/store/search-utils.ts:14,53`）后归一化；时效衰减 `score×max(0.5, 0.5^(天/半衰期))`（`search-utils.ts:30-47`） |
| 衰减/巩固 | 衰减地板 0.5「老记忆最多掉一半，永不沉底」（`search-utils.ts:16-18`），且**只在读路径生效、去重路径强制不用**（`search-utils.ts:27`，防同事实双记录）；巩固=场景块 L2→画像 L3，按 chat/work 族隔离 |
| 注入预算 | `maxCharsPerMemory=500` + `maxTotalRecallChars=2000`（`config.ts:740-741`）；超限**按融合排名砍尾部**，单条截断带引导后缀「…(已截断；可用 memory_search 查看详情)」（`src/util/recall-budget.ts:11-12`），截完不足 40 字符整条丢弃（`recall-budget.ts:15`） |
| 失败降级 | 全 fail-open：embedding 失败→退 FTS 关键词（`src/store/l1.ts:856,1083`）；召回超时整轮跳过注入、绝不阻塞对话（`recall-budget.ts:79`），嵌入内层钳 3s 给 FTS 留时间（`recall-budget.ts:96`）；图谱是派生投影，失败返回空路不拖垮主检索（`l1.ts:939-941`）；蒸馏连败退避 60s×2ⁿ 封顶 30min（`trigger.ts:58-64`） |
| 代码体量 | **140 个 .ts / 45,962 行**（不含 dist 与 client UI）；运行依赖 5 个：`sqlite-vec`、`@node-rs/jieba`（原生模块）、`undici`、`schemastery`、`dsh-reference-session-collector`；工具注册 **19 个**（`src/tools/index.ts:257…1904`），按 `reg('mutate'/'graph'/'ruminate'/'room'/'conflict'/'skills')` 分组 + `cfg.tools` 总闸（`tools/index.ts:133,157`） |

**值得抄的**
1. **截断即引流**（`recall-budget.ts:11`）：注入被截的那条不是损失，是告诉模型"全文在工具侧"。→ `summary.mjs` 里每条记忆截到 N 字符时附一句指路，`syn.mjs` 的深度检索工具接手全文。
2. **读路径衰减 / 写路径不衰减**（`search-utils.ts:27`）：衰减只用来排展示名次，去重找旧记录时必须无视新旧，否则同事实落两条。→ `decay.mjs` 只被 `syn.mjs` 调用，`consolidate.mjs` 的查重入口显式排除。
3. **阈值爬坡**（`trigger.ts:12-22`）：新用户第一轮就出记忆（阈值 1），经验够了自动翻倍到稳态。→ `consolidate.mjs` 一个 `number` 状态即可，不需新增模块。

**别学**：四套存储并存（JSONL + SQLite + MD 投影 + 遗留导入）= 一致性靠 800 行同步代码养着；`sqlite-vec`/`jieba` 两个原生依赖直接毁掉"无第三方依赖"；19 个工具里 `memory_resolve_conflict`/`memory_migrate_relation`/`memory_reproject` 全是给重度用户的，我们不要。

---

## 2. AskTheWay/dsh-auto-memory（Claude Code 风格 typed memory）

一句话：**最接近我们体量的参照物**——纯文件、零外部服务、2 个依赖，靠"索引进系统提示词 + 工具按需读全文"两段式省 token。

| 7 问 | 结论（含出处） |
|---|---|
| 存储格式 | 一条记忆 = 一个 `.md` + YAML frontmatter（`src/store.ts:13,21,215`）；目录 `<memoryDir>/--<project-slug>--/*.md` 与 `_user/*.md`（`store.ts:411-413`，用户级用下划线前缀避开 slug 冲突，`src/types.ts:60`）；`MEMORY.md` 是**派生物**，每次写入/删除后全量重建（`store.ts:10`） |
| 捕获时机 | 会话内只把人类原文与模型回复累积进内存缓冲（`src/consolidate.ts:219-237`，`source.kind !== 'user'` 直接丢，`consolidate.ts:223`）；**`agent/disposed` 时启发一次 LLM 固化**（`consolidate.ts:240`），`delegationDepth>0` 的子代理跳过（`consolidate.ts:247`）；默认 `autoSummarize=false`（`src/index.ts:49`） |
| 召回打分 | 不做实时检索：常驻的是 `MEMORY.md` 索引（每行 `- [标题](name.md) — 摘要`，`src/prompt.ts:57-67`），模型自己按索引点开 `memory_read` 看全文；**主动联想**=`memory_read` 时展开正文里的 `[[name]]`，一层不递归、上限 3 条、自链排除（`src/links.ts:9,24-38`） |
| 衰减/巩固 | 三因子排序 `importance × 0.995^天`（Generative Agents 免 embedding 版，`store.ts:371-379`），pinned 永远排最前（`store.ts:272-280`）；**软淘汰**=超过 `staleAfterDays` 且 `reads===0` 只从索引隐藏、文件保留（`store.ts:293-297,406`），默认 0 即关闭（`index.ts:52`）；查重=同名→name 词覆盖 ≥0.6→描述 Jaccard ≥0.7，命中就**复用同名覆写**（`src/matching.ts:71-76,117`） |
| 注入预算 | 整段注入 budget=`maxBytes` 默认 4096 字节（`index.ts:46`），净预算 `max(1024, maxBytes - 政策文本 - 协议壳 - 96)`（`prompt.ts:152-154`）；超限**逐行保留、超长单行跳过而不是终止**（防一条臃肿行顶掉后面全部，`prompt.ts:100-108`），尾部留 `…(index truncated at N bytes)`（`prompt.ts:109`）；**无记忆时整段消失**（`prompt.ts:10-11`） |
| 失败降级 | 固化全程静默：一切异常 `ctx.logger.warn`，绝不影响会话与 resume（`consolidate.ts:15`）；无 `llm` 服务/无路由信息直接跳过（`consolidate.ts:253-254`）；锁用 `withLockRecovery` 包 `MEMORY.md`（`store.ts:471,530`） |
| 代码体量 | 服务端 `src/*.ts` 仅 **12 个文件 / 3,170 行**（含 Web 面板共 4,954 行）；运行依赖 **2 个**：`schemastery`、`yaml`；工具 **6 个**：`memory_write/read/list/delete/prune/delete_all`（`src/tools.ts:48,125,184,246,280,362`） |

**值得抄的**
1. **两段式注入**（`prompt.ts:71-126` + `links.ts`）：系统提示词只放"标题+一行摘要+文件名"，正文按需读，`[[name]]` 一层展开做联想。→ 这正是 `summary.mjs`+`syn.mjs` 的分工，索引行宽度固定、正文永不进提示词。
2. **单行不顶全局**（`prompt.ts:100-108`）：预算裁剪时 `continue` 跳过超长行而非 `break`。→ `summary.mjs` 的裁剪循环直接照搬，改动 3 行。
3. **软淘汰而不是删除**（`store.ts:293-297`）：`reads===0 && 超期` 才隐藏，pinned 免疫，文件永远在。→ `decay.mjs` 输出"隐藏标记"给 `summary.mjs` 过滤，`consolidate.mjs` 不动磁盘。

**别学**：`{{ }}` 转义的 `neutralizeBraces` 循环（`prompt.ts:33-39`）是宿主提示词插值太严格的补丁，peer 升级后该整段删除；`memory_prune`/`memory_delete_all` 两个管理工具（`tools.ts:280,362`）对我们是纯负担；frontmatter 里塞 `created/updated/lastRead/reads/pinned/importance/disabled/origin` 九个字段，解析/序列化各写一遍（`store.ts:174-250`），我们保持 JSONL 单行就行。

---

## 3. Culeot/dsh-memory（跨会话长期记忆 · 存储沙箱）

一句话：**schema 与打分写得最漂亮的一份**——zod 单一事实源 + 可解释打分，但把存储全托给宿主 storage hub，等于放弃了自己的落盘。

| 7 问 | 结论（含出处） |
|---|---|
| 存储格式 | 不自己管文件：声明一个 storage domain `memory` v1，单表 `records`，主键 `mem_<hex>`（`src/spec.ts:59-65`），经 `ctx.storageDomain` 落到宿主 `$DSH_HOME/storages`（`spec.ts:4-6`，json 后端即纯 JSON 文件） |
| 捕获时机 | 不做自动捕获，全靠工具与协议提示词主动写（`src/index.ts:905-940`）；唯一"自动"是**同类错误第 N 次出现时递一条提醒**让模型自己固化 `kind=lesson`（`index.ts:1177-1193`，按 code/message 指纹计数） |
| 召回打分 | 完全可解释的加法基分 `base = 3×整串命中 + 1.5×tag + 1.2×qword + 2×bigramJaccard + 0.8×unigramJaccard + bm25`（`src/search.ts:250-313`），`base<1.0` 直接判不命中（`search.ts:129`）；再乘 `importanceBoost(1+0.1×(imp-1)) × recencyBoost(0.5^(天/90)) × accessBoost(1+0.15·ln(1+n)) × supersededPenalty(0.25)`（`search.ts:316-324`）；语义通道按 `w=0.3` 与词法线性融合、`semanticMin=0.5`（`search.ts:166,169`） |
| 衰减/巩固 | 不靠删靠**取代链**：`supersededBy` 是数据不是正文（`spec.ts:44-54`），老记录保留、排序乘 0.25 压下去（`search.ts:171-177`）；近重复自动合并（同 kind/scope/project 且 token Jaccard ≥0.7，`index.ts:490-505`），**合并后沿用旧 TTL 不偷偷续期**（`index.ts:508`）；容量 400 条，超了淘汰最低价值、importance-3 免疫除非全是关键（`spec.ts:69-70`，`index.ts:439-456`） |
| 注入预算 | 每次召回只要 `recallLimit=3` 条、每条 `recallContentMax=400` 字符（`spec.ts:79-82`）；还有 `budgetRatio` 只留接近最高分的那几条——"注入一条边缘记忆不是中性的，它浪费预算还会误导"（`index.ts:189-208`）；压缩泥沙 `sediment` 每次 ≤3 条、进程级冷却 300s（`spec.ts:83-86`） |
| 失败降级 | 语义通道整体可选：`SemanticIndex` 不可用时报 `unavailableReason`、调用方回落词法（`src/semantic.ts:9,138,258`），无模型目录就 `null` 不报错；写入前比对文件指纹，发现被外部改动则拒绝覆盖（`index.ts:855-874`） |
| 代码体量 | **6 个文件 / 2,669 行**（`index.ts` 1207 + `search.ts` 501 + `rpc.ts` 320 + `semantic.ts` 282 + `spec.ts` 94 + client）；运行依赖 **0 个**（`zod`/`schemastery`/transformers 全在 peer）；工具 **7 个**：`remember/recall/index/forget/sediment/reload/import`（`index.ts:906,940,967,990,1017,1073,1089`） |

**值得抄的**
1. **分数可解释**（`search.ts:255-334`，`reasons` 数组逐项列贡献）：召回结果自带"为什么是它"。→ `syn.mjs` 在每命中项上挂 `reasons[]`（BM25 命中词、affect 加成、衰减系数），调试和调参都不用猜。
2. **取代链是数据**（`spec.ts:44-54`）：老记忆不删、不靠模型在正文里手写"已被X更新"，而是记一条 `supersededBy` 让排序自己压下去。→ `consolidate.mjs` 合并时给旧行写 `supersededBy`，`syn.mjs` 乘 0.25，磁盘仍是 JSONL 追加。
3. **预算按相对分收敛**（`index.ts:189-208`）：只留接近最高分的条目，不给边缘记忆烧 token。→ `summary.mjs` 加一个 `budgetRatio` 参数，5 行以内的改动。

**别学**：把落盘完全交给 `ctx.storageDomain`（`spec.ts:59-65`）——查询能力被宿主锁死，我们自己的 JSONL/Markdown 才是可 git、可人读的事实源；`memory_reload`/`memory_import`/`memory_sediment` 三个工具（`index.ts:1017-1089`）是我们 7→4 个工具时要砍的那类；`MAX 400 条` 的硬容量上限（`spec.ts:70`）配淘汰策略，等于把"记忆会不会丢"变成一个调参问题。

---

## 取舍清单（要做的事）

| 优先级 | 动作 | 落点 | 依据 |
|---|---|---|---|
| P0 | 注入截断加"全文在工具侧"指路后缀；总量超限按排名砍尾部 | `summary.mjs` | prime `recall-budget.ts:11` |
| P0 | 裁剪循环遇超长单行 `continue` 不 `break` | `summary.mjs` | auto `prompt.ts:100-108` |
| P0 | 衰减只用于展示排序，查重路径强制关闭 | `decay.mjs` + `syn.mjs` | prime `search-utils.ts:27` |
| P1 | 召回结果挂 `reasons[]`（命中词/affect/衰减各记一项） | `syn.mjs` | Culeot `search.ts:255-334` |
| P1 | 合并写 `supersededBy`，排序乘 0.25 | `consolidate.mjs` | Culeot `spec.ts:44-54` |
| P1 | 软淘汰（超期且零引用→隐藏不删），pinned 免疫 | `decay.mjs` | auto `store.ts:293-297` |
| P2 | 蒸馏阈值爬坡 1→2×→稳态 | `consolidate.mjs` | prime `trigger.ts:12-22` |
| P2 | `budgetRatio` 只留接近最高分的条目 | `summary.mjs` | Culeot `index.ts:189-208` |

**明确不做**：四套并存存储、SQLite/原生模块依赖、按族隔离的双仓储、19 个工具、`{{ }}` 插值补丁、宿主持久层托管、硬容量淘汰。

**体量参照**：三家里最像我们的是 dsh-auto-memory（3,170 行 / 2 依赖 / 6 工具）——我们 5,911 行要瘦到那个量级，主要砍的是没人调用的分支而不是机制。