# B — 存储与衰减（外部竞品取经）

> 只读源码调研，结论均标 `文件:行号`。四个对象：`dsh-mnemon` / `dsh-meow-memory` / `StrataGate-AgentMemory` / `Veyra`。
> 取源方式：mnemon、meow-memory、Veyra 走 `git clone --depth 1`；**StrataGate 的 GitHub 仓库已 404（转私有或已删），改从 npm `stratagate-dsh@0.3.23` 的 dist 包读源码**（`dist/plugin.js`，17,678 行未压缩），行号以该包为准。
> 落点约定：我们现有模块只有 `fs-safe.mjs`(存储) / `index.js`(注入+工具面) / `decay.mjs`+`consolidate.mjs`(衰减巩固) / `autocapture.mjs`(捕获) / `config.mjs`。下文“值得抄”一律指定这 5 个以内。

---

## 1. dsh-mnemon（643★，可组合视图式上下文）

**一句话**：它不是记忆库，是「记忆插件总线」——真正值得抄的是 `source 能力枚举 + 视图预算 + 确定性校验` 这套装配纪律，而不是它那 22 个依赖。

| # | 问题 | 结论与证据 |
|---|---|---|
| 1 | 存储格式与落盘 | **不自带存储**。Source 插件各自负责：`memory-spaces` 用 `MEMORY.md` 存档、文档索引入 provider（`plugins/dsh-mnemon-source-memory-spaces/src/source.ts:520`）；memory 主体交给 10 个 provider（mem0/honcho/hindsight/supermemory…）。同一份数据可能落多处，宿主只认 provider 的 `revision`。 |
| 2 | 捕获触发 | **不是 hook，是“提示词槽”**。`capture` 扩展槽只提供一段 instruction + 准许的 actionIds（`src/core/contracts/view.ts:170-172`），`auto-capture` 插件写死“本轮至多记一条新的持久偏好”（`plugins/dsh-mnemon-strategy-auto-capture/src/index.ts:15`），由模型自己决定是否调 action。零定时器、零自动抽取。 |
| 3 | 召回与打分 | **宿主不打分**。Strategy 只产出 `MemoryViewSpec`（选哪些 source、哪些 route/action），排序下沉到各 source 内部（`src/core/composition.ts:612` compose → `:629-660` 逐 source 读 projection）。**没有统一打分器**，因此也没有跨源可比性。 |
| 4 | 衰减·巩固·压缩 | 由 strategy 决定：`runtime` source 有 `runtime-capacity` 归档策略（`src/core/contracts/view.ts:150` 注释：写满前归档旧 Runtime 条目）；记忆本身无时间衰减。**没有衰减函数**。 |
| 5 | 注入 token 预算与裁剪 | 全仓库最值得抄的一段。`DEFAULT_MEMORY_VIEW_BUDGET = { maxProjectionCharacters: 64*1024, maxRoutes:16, maxActions:16, maxEvidenceResults:16, maxEvidenceCharacters:16*1024 }`（`view.ts:228-234`）；每个 source 还能单独 `projection.maxCharacters`（`view.ts:246-249`）；**超预算直接抛错**而非静默截断：`memory View projection exceeds the root-turn budget`（`composition.ts:654`）。 |
| 6 | 失败与降级 | 显式 `required?: false`：source 读失败 → 记一条 diagnostic 并从本视图剔除，其余照常（`composition.ts:642-646`）；required 源失败则整轮抛错。另有**确定性双跑**：compose 与 extension 各跑两遍比 canonical JSON，不一致直接拒（`composition.ts:607-616`）。 |
| 7 | 代码体量 | 622 个 `.ts/.js/.mjs`、29,931 行；**运行时依赖 22 个**（10 provider + 4 source + 4 strategy + zod/yaml/fflate），peer 还要求 React 18 + cordis。 |

**值得抄（≤3）**
1. **预算即契约**：`{字符上限, 路由数, 动作数, 证据数, 证据字符}` 五元组显式化，超限报错而不是偷偷截断 → 直接进 `index.js` 的注入装配，替掉我们现在散落的 slice。
2. **可选源失败降级**：一个可选源读失败只降级它自己，出 diagnostic 不炸整轮 → 进 `fs-safe.mjs` 的读路径，我们现在是整块 try/catch 静默。
3. **双跑确定性校验**：装配函数必须是纯函数，跑两遍比哈希 → 进 `index.js` 组装函数，一条断言就能挡住“注入内容随调用次数漂移”。

**别学**：22 个运行时依赖 + provider 适配层 + React peer。它的复杂度全在“支持 10 家外部记忆后端”，我们只有本地 JSONL/MD，套进去等于给自己造插件市场。它的 composable 抽象没有打分也没有衰减，解决的不是我们的问题。

---

## 2. dsh-meow-memory（七层 SQLite）

**一句话**：七层是按「谁会读它」分表，不是按数据形状分；真正值钱的只有 60 行艾宾浩斯分桶，七张表本身是负债。

| # | 问题 | 结论与证据 |
|---|---|---|
| 1 | 存储格式与落盘 | SQLite（`node:sqlite` 内置），`<ws>/.dsh-meow/memory.db`，WAL + `busy_timeout=5000`（`src/db.ts:200-214`）。**七个 level 各一张表**：soul/user/project/fact/lesson/topic/rules（`src/db.ts:28,181-197`），共享 `COMMON_COLS`（id/title/content/importance/keywords/status/source_session/hit_count/created_at/updated_at/last_accessed_at，`:166-178`），差异列只有 project/subcategory/corrected/goal。另有 4 张流程表：dream_log、windows、dream_meta、dream_skip（`:216-244`）。id = base36 毫秒前缀 + 26 位随机，**靠 id 排序代替创建顺序索引**（`:160-164`）。 |
| 2 | 捕获触发 | 工具直写 `memory_remember` + **空闲 dream 整理**：窗口空闲 ≥ `idleMinutes`（默认 180 分钟）触发，北京时间 09:00–12:00 / 14:00–18:00 峰时及前 15 分钟抑制，同一时刻只许一个 dream（`src/dream.ts:18-25`，配置见 `src/index.ts:242`）。 |
| 3 | 召回与打分 | 标准 BM25（k1=1.5, b=0.75，`src/bm25.ts:275-287`）× 艾宾浩斯权重；中文分词走 CJK 相邻 bigram + 字母数字整词，NFKC 归一（`:53-79`）；**豁免规则**：`importance≥3` 或原始分 ≥0.85×本轮最高分则不衰减（`:294-296`）。 |
| 4 | 衰减·巩固·压缩 | 衰减**只在检索时乘**，落库权重不变：9 个天级分桶 `<1d:1.0 / <2d:0.9 / <4d:0.8 / <7d:0.65 / <15d:0.5 / <30d:0.35 / <60d:0.25 / <180d:0.15 / else 0.08`（`src/bm25.ts:210-221`）。巩固= dream 把本窗口条目 `updated_at` 统一改写为 dream 前最后对话时间 T，并归档被取代的旧条目（`src/dream.ts:15-17`）。 |
| 5 | 注入预算与裁剪 | 无字符级预算，靠**结构配额**：soul/user 全量 + project/topic 只给标题导引（`titleMax=40`）+ 首条用户消息关键词命中 fact/lesson 至多 `hitTopK=2`（`src/inject.ts:26`）；压缩重注入另有 `MAX_REINJECT_PROJECTS=8`、`MAX_REINJECT_WRITTEN=20`（`:60-63`）。 |
| 6 | 失败与降级 | pre-step 注入整体 fail-open：插件抛错只 warn，放行原始消息（`src/index.ts:1362-1369`）；写锁冲突靠 `busy_timeout` 自旋 5s，超时抛给上层（`db.ts:210-214`）；dream 有 owner/claim 门防并发（windows 表 `dream_owner`，`db.ts:223-233`）。 |
| 7 | 代码体量 | 60 个文件、18,423 行（`src/` 11,971 行）；**运行时依赖 0**，peer 仅 schemastery；仅 Node 内置 sqlite。**注：七个业务表 `CREATE INDEX` 数量 = 0**（全仓 grep 实测），status/level 过滤全靠扫表。 |

**值得抄（≤3）**
1. **天级分桶衰减 + 双豁免**：9 段常数表比连续指数更好调、更好解释，`importance≥3` 与“贴近榜首”两个豁免正好治「重要旧记忆被新噪音压掉」→ 进 `decay.mjs`（94 行，塞得下）。
2. **巩固时统一改写 updated_at 为 T**：一次封窗把“记忆时间戳”变成会话级一致量，避免逐条漂移 → 进 `consolidate.mjs`。
3. **WAL + busy_timeout=5000 + 单写者 claim**：多实例共享同一库的现成答案 → 进 `fs-safe.mjs` 的写入锁实现。

**别学**：七张结构近乎相同的表。它带来 7 份 CRUD、7 份 upgrade、7 份迁移（`db.ts:250-259` 的按表补列），换来的只是 4 个差异列；而且**一个索引都没建**，所谓“分层查询优势”根本没落实。我们该用「一张表 + 一个 level 列 + 一个 level 索引」。dream 那套 400 行调度（峰时抑制/窗口恢复/claim）也不值得背。

---

## 3. StrataGate-AgentMemory（六层时间衰减 + 事件/关系沉淀）

**一句话**：六层是**同一段对话的六个分辨率视图**（L0 标题 … L5 原文），衰减挂在“被采纳次数”上而不是“被检索次数”上——这两点是它最硬的设计。

| # | 问题 | 结论与证据 |
|---|---|---|
| 1 | 存储格式与落盘 | 单库 SQLite，**全部 STRICT 表**、schema v10（`dist/plugin.js:3658-4006`）。核心：`memory_spaces`（含 `block_decay_lambda`，`:3690-3700`）、`blocks`、`messages`、`events`（`:3761-3788`）、`elements`（`:3843-3861`）、`element_facts`（`:3876-3892`）、两张来源边表 `event_sources`/`element_fact_sources`。所有表以 `namespace` 为首列做多实例隔离。 |
| 2 | 捕获触发 | **按轮数封块**：默认 12 个完整轮 = 1 Block；到界时一个原子事务把消息搬进永久 L5 并写确定性 L4/L3（`docs/ARCHITECTURE.md:49-57`）；随后后台 summarizer 产出 L0–L2 并给 `shouldExtract`；再异步抽 Event，再投影成 Element（`:140-148`）。封块后先标 `model-pending`：**不进衰减、不能替换原生历史**（`:54`）。 |
| 3 | 召回与打分 | 两条可检视排序源：①字段加权 BM25（含汉字重叠 bigram，`plugin.js:2090-2110`）；②结构化字段排序（参与者/事件类型/时间范围/元素名/类型）。用 **RRF 融合**：`score += weight/(60 + rank + 1)`，并列时比 bestRank 再比 id（`:458-470`）。**明确不用 embedding**（`ARCHITECTURE.md:150-160`）。`rankScore` 只是排序量，不当置信度。 |
| 4 | 衰减·巩固·压缩 | 两套衰减：(a) **Block 显示层**：`w(age)=exp(-0.3·age)`，age 以 Block 位置计，权重决定“从锚点往下掉几层”（L5→…→L0），`λ>0.4` 不建议（`ARCHITECTURE.md:60-67`）；(b) **Event 权重**：`w(t,n)=max(floor, exp(-λ(n)·t))`，`λ(n)=0.15/(1+1.5·ln n)`，**n 是“被最终答案采纳”的次数，不是检索命中数**（`:155-170`）。关键度下限：routine 0 / preference 0.3 / identity 0.9 / safety 1.0；pinned=1；superseded 上限 0.1；forgotten/archived=0（`plugin.js:2110-2116` + `ARCHITECTURE.md:172`）。 |
| 5 | 注入预算与裁剪 | 事件卡注入 `eventBudget=16000` 字符、标题索引 `titleBudget=4000` 且最多 120 条，超了 break 而非截半条（`plugin.js:3246-3250`、`:3300-3304`）；工具响应返回“紧凑搜索卡”（ID/摘要/时间/证据引用），正文与图边要另调 expand 才展开（`ARCHITECTURE.md:150-155`）。 |
| 6 | 失败与降级 | 五段式：schema_version 校验失败 → 加载即 fail closed（`plugin.js:2045-2079` 的 snapshot 校验）；抽取/投影是持久化 job 状态机 `pending running failed`，重启把 running 判 failed 且**可重试而不重抽事件**（`ARCHITECTURE.md:140-148`）；`element_sources` 故意不设外键，靠每次装载时 `validateReferences` 兜（`plugin.js:3863-3875` 注释）；关系只认“证据仍暴露”的边，`GRAPH_PROVENANCE_LIMIT=6`（`:470-500`）。 |
| 7 | 代码体量 | npm 包 74 文件、解包 41 MB（大头是 docs 截图）；**核心 `dist/plugin.js` 17,678 行**（含注释掉的源码段落，实际可读实现约 6k 行）；运行时依赖仅 3 个：`ngraph.graph`、`ngraph.leiden`、`semver`。 |

**值得抄（≤3）**
1. **采纳驱动衰减（adoption, not retrieval）**：`λ(n)=0.15/(1+1.5·ln n)` + 关键度下限——检索不算数，只有“真被写进答案”才续命。这条几乎零成本，直接进 `decay.mjs`，替掉我们按时间一刀切。
2. **同一对象的 L0–L5 六视图 + 指针式降级**：原始 L5 永不删，默认展示级别随距离指数下移，要细节再 expand。落到 `consolidate.mjs`：一个条目存“全量正文 + 4 段压缩”，按 weight 选展示层。
3. **结构化排序 + BM25 的 RRF 融合（无向量）**：与我们的 BM25-lite 同构，加一两个结构化信号（项目/时间/关系）做 RRF 即可，进 `index.js` 的召回组装。

**别学**：完整的事件抽取流水线（Block→Event→Element→Fact 四段 job + 四张来源边表 + 图社区检测 `ngraph.leiden`）。它的复杂度代价是 17k 行 bundle、7 类后台 job、每次装载全量引用校验——为了“可追溯的因果关系”，我们不需要付出这个量级。同样别学 namespace 多租户列。

---

## 4. Veyra（记忆 + RAG 统一混合检索）

**一句话**：把“记忆”当成有权威等级的知识记录，用 8 维固定权重 + 多通道 RRF 做可解释排序，并**在最终字符串上**执行字符预算——融合思路值得抄，8 个维度不值得。

| # | 问题 | 结论与证据 |
|---|---|---|
| 1 | 存储格式与落盘 | 每项目一库 + 一库共享：`$DSH_HOME/veyra/projects/<projectId>/memory.db`、`$DSH_HOME/veyra/reusable/memory.db`（`src/store.mjs:8-12`）。单表 `memory`（kind/status/validation/authority/confidence/scope/tags/evidence/relations/source 全 JSON 列）+ FTS5 外部内容表 `memory_fts` 与三支同步触发器，tokenizer `porter unicode61`（`:48-95`）；6 个普通索引（project/status/authority/kind/forgotten/hash，`:97-102`）。 |
| 2 | 捕获触发 | 模型显式调用（`remember`/`learn.mjs`/`understand.mjs`）；**自动演化只加边不改真相**：只允许 extends/updates/contradicts/supersedes，且 supersede 必须在“方向性替换证据 + 共有主语”下才成立（`src/evolve.mjs:9-27,71-78`）。相似 ≠ 同一，绝不自动合并。 |
| 3 | 召回与打分 | 两段式。**复合分**：`relevance .32 / evidence .18 / validation .18 / proximity .14 / confidence .10 / semantic .10 / freshness .08 / relationship .04`（`src/retrieve.mjs:223-232`），关系分 = `min(.5, 边数×.1)+min(.5, 池内互连×.25)`（`:207-221`）。**再叠 RRF**：`Σ w/(60+rank)` 归一化到 (0,1]，同分通道（如全池 polarity 一致）自动剔除不计秩（`:432-500`）。互斥约束：极性不兼容者不得越过兼容者（`:259-268`）。 |
| 4 | 衰减·巩固·压缩 | **没有时间衰减函数**；新鲜度只占 0.08 且按 `freshness_tier` 分档。生命周期：120 天未用标 `stale`（`evolve.mjs:34`），`forgotten` 是标志位不删行，supersede 是**有向边**（退役者→替代者，一条事件一条边，`evolve.mjs:16-20`）。 |
| 5 | 注入预算与裁剪 | 预算打在**最终拼接字符串**上：`DEFAULT_RECALL_CHARS=6000`，超了按行整行丢（不留半行）并附一行 `…recalled context truncated at the character budget`；标题与信任框架永远保留（`src/context.mjs:37-63`）。证据每记录最多 3 条、每字段 120 字符（`:20-23`）；入边扫描上限 200（`:26`）。 |
| 6 | 失败与降级 | 时间窗/上下文一律 **fail-open**：端点不可解析 → 当 current，不在当前环境声明的键不参与冲突（`retrieve.mjs:358-428`）；而 schema_version 变了就 fail closed（store 层）。通道无区分度时返回 null，回落纯复合排序（`:446-450`）。 |
| 7 | 代码体量 | 109 个文件、33,973 行（`src/` 12,978 行）；**运行时依赖 0**，peer 仅 cordis/dsh-tools，要求 Node ≥22.5（FTS5）。 |

**值得抄（≤3）**
1. **最终字符串级字符预算 + 整行截断 + 明示一行**：比“限制条数”可靠得多，`recallLimit` 管不住长正文这点它踩过。→ 进 `index.js` 注入出口，与 mnemon 的预算五元组合并成一处。
2. **RRF 融合多个同池排序通道，且自动剔除无区分度通道**：我们只有单一 BM25 分，加“关键词命中/项目接近度/关系”三个通道做 RRF，几乎不改存储 → 进 `index.js`。
3. **supersede 有向边 + forgotten 只置位不删行**：历史可回溯、可 undo，比物理删除安全 → 进 `consolidate.mjs` 的归档分支。

**别学**：8 维权重 + authority/validation/confidence/scope 四套正交元数据。那是给“多来源知识库”做可信度治理的，我们的记忆没有外部权威源，这四维会全部退化成常数，只留下调参负担。同理别学 polarity/causal/temporal 那套 §10 通道矩阵——它 1000 行检索文件里至少 400 行在伺候这些维度。

---

## 横向取舍（给我们瘦身用）

| 维度 | 最省的做法 | 出处 |
|---|---|---|
| 存储 | 单表 + `level` 列 + 该列索引；WAL、busy_timeout 照抄 | meow 反例 / meow `db.ts:210` |
| 衰减 | 天级分桶常数表（9 段）+ 双豁免；要更细再加采纳次数项 | meow `bm25.ts:210-221` + Strata 采纳衰减 |
| 预算 | 字符上限打在**最终字符串**，超限整行丢并明示 | Veyra `context.mjs:55-63` + mnemon 五元组 |
| 召回 | BM25 + 2–3 个结构化通道做 RRF（K=60），不引向量 | Strata `plugin.js:458` / Veyra `retrieve.mjs:432` |
| 捕获 | 提示词槽（模型自主）或空闲窗口整理，二选一，别两套都要 | mnemon capture 槽 / meow dream |
| 失败 | 只读路径 fail-open，写路径与 schema 版本 fail closed | Veyra / Strata |

**结论**：四个仓库里唯一“小而可整段搬”的是 meow 的 60 行分桶衰减和 Strata 的采纳式 λ；mnemon 的预算五元组与 Veyra 的最终字符串预算可以合成我们唯一的一处注入闸门。七层、六层、8 维这三套“层数美学”都不该进我们的模块——我们要的是 5 个模块里各加 30–80 行，而不是加层。
