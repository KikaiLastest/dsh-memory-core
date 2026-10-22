# C · 审计日志 / 人设卡 / 文档中枢 / 平台级

> 只读取证，结论全部来自源码（.js/.mjs/.ts/.py），行号对应各仓库 clone 的 HEAD。
> 本机路径：`D:/dsh-workspace/projects/_ext/`。行数口径：排除 node_modules/dist/tests/web/site/examples。
> 我们的 5 模块简称：**store**(fs-safe+sanitize) / **capture**(autocapture+syn) / **recall**(summary+abstain) / **judge**(affect+decay+consolidate) / **surface**(index+client+config+status)。

---

## 1. EternalNight996/memory-eternal（v0.12.0）— SQLite + 审核 + 审计

**存储与落盘**：单库 `memory-eternal.db`，`node:sqlite` 的 `DatabaseSync`，WAL + foreign_keys（lib/db.js:113-124）。关键设计是**物理分表**：`cards` 只存 approved，`quarantine` 存 pending/rejected/deleted（lib/db.js:140-148，DDL 151-246）。官方理由写在注释里：v0.9「一张表 + status 列」漏了三处 `WHERE status='approved'`，改成分表后漏写也不泄漏（db.js:145-147）。另有 card_updates（追加式修订）、feedback（召回反馈）、audit_log（状态迁移，db.js:225-233）、card_sequence（两表共享 id 发号器，因为双 AUTOINCREMENT 必撞号，db.js:235-242）。Markdown 只剩导入/导出用途（db.js:383 的 migrateFromMarkdown、vault.js:751 exportCards）——**md 是投影，不是真相**。

**捕获触发**：`ctx.on('agent/turn-stopping')`（index.js:862），按 session 记水位 seq，取新增事件，异步 scheduleCapture，绝不在监听器里 await LLM（index.js:543）。进 LLM 前有两道机械闸：stripRuntimeNoise 用固定标签清单剥掉 `<system-reminder>`/`<team-*>`/skill 目录行（capture.js:51-86），「剥完是否为空」判纯注入（capture.js:93-97），再加 DURABLE_SIGNALS 正则预筛才肯花钱（capture.js:41）。蒸馏 maxTokens=4000（capture.js:33-38）。

**召回打分**：不是 BM25，也不是向量。`SELECT * FROM cards ORDER BY updated_at DESC` 全表进 JS 逐条 `includes`：整句命中 +3，每个分词 +1，semantic 开关再加 `textSimilarity*6`（vault.js:690-712）；然后反馈重排 ±2/次（vault.js:713-729），工具层默认 `minScore:2`（index.js:1006）。**比我们的 BM25-lite 更土**，但它敢全表扫，因为行在 SQLite 里。

**衰减/巩固**：没有衰减、没有 TTL。巩固全靠人：`optimizeCandidates` 做 O(n²) 相似度 ≥0.55 配对（vault.js:1072-1089），90 天未改只是候选清单（vault.js:1087）；refine.js 补「矛盾扫描」——LLM 只判 duplicate/complement/conflict/unrelated 四类，人拍板，决策落 `.refine-decisions.json`，apply 只允许可恢复动作（refine.js:1-15）。它把「相似 ≠ 可合并」写进了 issue #36。

**注入预算与裁剪**：自动召回是**纯规则注入**，systemPrompt 一段 6 行，教模型何时调 `memory_recall`，不塞任何记忆正文（index.js:898-947）；预算靠裁结果形状——每条 snippet 默认 130 字（index.js:978,1014）、可选正文 800 字（index.js:1015）、limit 每调用。第 6 条红线明确「禁止自行 approve」（index.js:916-918）。

**失败与降级**：只有加码，没有退路。打开库时读回真实 journal_mode + 写探针，因为 PRAGMA 失败不抛错（db.js:16-20, 36-56）；坏了给 rebuild 指引 + doctor 子命令；watchdog.js 1510 行保活；沉淀停滞探测（index.js:1026）；健康异常直接注入 prompt 让模型转述给用户（index.js:926-932）。**`import { DatabaseSync } from 'node:sqlite'` 是硬导入（db.js:6），engines 要求 node>=22，没有 JSONL 回退。**

**体量**：116 个文件 13232 行（index.js 1576、watchdog 1510、vault 1227、api 1182、capture 985），1 个运行时依赖（schemastery）。

**值得抄**
1. 审阅态物理隔离 → store：JSONL 分两条流 `approved.jsonl` / `pending.jsonl`，召回只打开前者。省掉每处 filter，且把「漏判」变成「读不到」。
2. audit_log 只记状态迁移（path, old→new, changed_by, reason；vault.js:506/521/551）→ store 里加 `audit.jsonl` 追加写，约 20 行，替代全量快照。
3. 捕获前的机械噪声剥离（capture.js:51-86 + 「剥完为空」判定）→ capture，直接砍垃圾条目，零 LLM 成本。

**别学**：watchdog+web/api+refine+doctor ≈ 一半体量都是运维和 UI；双表共享 id 发号器是「状态机」的税，单流 JSONL 不需要；全表 includes 召回说明它的检索没比我们强，别拿它的性能结论套我们。

> 一句话：双表隔审阅态 + 迁移式审计是真金，但得用 1.3 万行换；我们只要那两个不变式，不要那套运维。

---

## 2. Scorp1o117/dsh-soul-md — 人设卡 + 分层记忆

**存储与落盘**：人设存**设置 YAML** 的 `soul-md.cards: {name -> markdown}`（index.js:5-8）；记忆存文件 `$DSH_HOME/soul-md/memory/<scope>/core.md` + `<scope>/topics/<key>.md`，带老式 `<scope>.md` 回退（memory-layout.js:64-104）。即：**人设走配置、记忆走文件，两层各自可替换**。

**捕获触发**：没有自动捕获，全靠 6 个工具（memory_append/read/search/rewrite、soul_read/update，index.js:580/633/686/715/755/786）。它把「值不值得记」完全交回模型与用户。

**召回打分**：纯词法。中文按字二元组切词（memory-recall.js:2-10），打分 = 命中标签×4 + 摘要×2 + 正文×1（memory-recall.js:26-29），top 5（1-20）。**确定性、无 IO、无模型**，48 行。

**衰减/巩固**：全无。没有 TTL、没有合并、没有遗忘；删除是人的动作。分层替代了巩固：core 常驻、topics 按需。

**注入预算与裁剪**：`injectMaxChars` 默认 8000（index.js:86）、`recallMaxChars` 1600（index.js:92）。超限时 `retainMemoryEnds` 保留首尾各一半加 `…`（memory-layout.js:46-58），并附一句「部分未注入，请用 memory_read」；**先留满主题索引，余量才给 core**（index.js:300-311）——这条优先级排序很聪明。

**失败与降级**：readText 返回 null 即视为不存在（memory-layout.js:73-88），没有可失败的组件；超限降级为「截断 + 指路」。7 个测试文件覆盖原子写、scope 兼容、子代理跳过。

**体量**：14 个文件 2707 行（含 413 行测试；index 823、client 692），1 个运行时依赖。

**值得抄**
1. **人设解析链**：session 选择 > 工作区映射（按 cwd，忽略大小写，index.js:170-190）> 默认卡 > 无 → config，约 15 行，解决「换项目还念旧人设」。
2. **索引/正文两级注入**：索引（key — 标题：摘要，memory-layout.js:34-44）常驻、正文走工具；8000 字预算里先保索引（index.js:308-311）→ recall。
3. **压缩后回捞**：监听 `compaction/prune` 与成功的 `compaction/end` 置 pending，下一条用户消息时把本会话读过的 topic 重新注入（index.js:250-277）。这条我们完全没有，而它正是长会话里「刚查过就忘」的解药。

**别学**：拿 settings YAML 装整张人设 markdown（每次读配置都带正文）；legacy `<scope>.md` 与新目录双轨兼容（index.js:435-468）为了迁移留了上百行——我们还没发过版，别先背这个包袱。

> 一句话：2700 行里值钱的只有「人设解析链 + 索引/正文两级 + 压缩后回捞」三样，其余是兼容层和设置页。

---

## 3. bbqisbbq/dsh-tiddlywiki — 16 工具 / 文档中枢

**存储与落盘**：TiddlyWiki 自己的 tiddlers（`.md`+`.meta`+`.tid`+`files/`，README:41），整个 wiki 目录是 git 仓库（自动 commit + 一键 pull/push，src/host/git.ts 609 行），读写都走 TW 的 REST（tw-api.ts:8-10）。**不是记忆存储，是「人可读 + git 可审计」的文档中枢。**

**捕获触发**：无自动捕获，README:9 明说不后台抓取。唯一自动写是 session-summary：扫 `sessionQuery` 的事件日志（tool/call 的 name+arguments、助手回复里的 wiki 链接），生成一篇会话汇总，写进 **volatile 命名空间** `$:/temp/dsh/session-summary/<id>`——不进 git、重启即消失（session-summary.ts:1-30）。这个「会话索引只活在内存」的取舍值得抄。

**召回打分**：TW filter + 相关度，查询按空白切词且**必须全命中**（AND，tools-read.ts:36-40）；先在工作区 tag 内收窄，0 条才扩全库，且回执明写「已收窄 / 已扩大」（tools-read.ts:59-63, 88-100）。另有 backlinks 做结构化召回——这是我们 BM25 之外的另一个维度。

**衰减/巩固**：不删。用 `valid-until`/`review-after` 硬字段 + `superseded-by`/superseded 标签，lint 只报**候选**，删除永远由人决定（tools-read.ts:381-414、prompt.ts:249）。语义是「时效声明」而非「衰减计算」。

**注入预算与裁剪**：一段 systemPrompt 段，slim 形状默认 ~1.9KB（README:47），可整体关闭、可换形状（prompt.ts:67-77）。**工具目录由 defineTool 定义收集生成**（tools.ts:44-58），专门防止 prompt 与工具签名漂移（历史漂移了 6 个签名）。

**失败与降级**：写路径统一收口 write-policy（TW 的 PUT 是整体替换，手拼 body 会清空人类笔记的自定义字段，write-policy.ts:1-40），带 `revision`/`expectedModified` 乐观并发；delete 默认进回收站；重启前排干 syncer 队列，排不干净如实回 `drained:false`。

**体量**：147 个 .ts + 84 .mjs + 10 .js，约 7.3 万行（src 3.4 万：styles-css 914、tools-support 803、index 704、routes 701…），1 个运行时依赖（tiddlywiki）。

**值得抄**
1. **工具目录从定义生成**（tools.ts:44-58）→ surface：手写 prompt 目录必然漂移，一行收集代码解决。
2. **会话索引放易失区**：本会话检索/写过什么，只留内存与面板，不落记忆库（session-summary.ts:1-30）→ capture，防污染。
3. **召回回执声明 scope**（「已收窄 / 0 条已扩全库」，tools-read.ts:59-63）→ recall：返回值里带一句，模型就不会把「本库没有」当成「世上没有」。

**别学**：16 个工具分 6 个文件、1600+ 行工具代码 + 700 行 prompt + 设置页/目录/公众号发布。**「文档库当记忆库」的成本不在存储，而在工具语义**——append/replace/rename 要处理引用改写、字段保留、并发令牌，每一件都是一条新不变式。

**关于「和我们的 docs+memory 双轨是否重复」**：存储层重复（都是 .md + 可 diff），职责不重复（它没有捕获、没有打分、没有人设、没有衰减）。结论：**不引入 wiki 层**，「读文档」继续走既有 docs 读取，记忆库只收「决策与教训」，两边靠一张目录卡相连即可。

> 一句话：它证明了「人机共用 .md + git 审计」很干净，但那是知识库不是记忆库；我们只借 prompt 目录生成和会话临时索引。

---

## 4. vectorize-io/hindsight — 平台级，看它的边界画在哪

**存储与落盘**：Postgres + pgvector，核心表 `memory_units` / `memory_links` / `chunks` / `entities` / `entity_cooccurrences` / `invalidated_memory_units` 全被 `MemoriesExtension` 一个接口圈住（memories/base.py:1-10），只允许该模块点名这些表；换 store 实现即可让 Postgres 完全不存这些行（base.py:14-30）。BM25 用 PG 扩展 pg_search 的 `to_bm25query`（sql/postgresql.py:380-393），另有 Oracle 后端（db/ops_oracle.py）。

**分层（重点）**：banks → 三操作 retain/recall/reflect → 四类记忆 world facts / experiences / observations / mental models（README:280-286）→ 底层四臂召回 semantic/BM25/graph/temporal（README:325-330）→ 后台 consolidation 由事实生成 observation（consolidator.py:1-14）→ worker 异步 → HTTP API（http.py 1.1 万行）+ MCP + CLI + clients + control-plane + helm。

**召回打分**：四臂并行 → 每臂先 `cap_per_source` 截断，防一个臂挤爆候选池（fusion.py:7-27）→ RRF 融合 k=60（fusion.py:29-45）→ cross-encoder 重排（cross_encoder.py 2980 行）→ 按 `max_tokens` 裁到预算（search/trace.py:30）。

**衰减/巩固**：没有时间衰减、没有遗忘曲线——全 engine 目录搜 decay/forget 只命中 `decay_factor` 字段（db/oracle.py:826）。「遗忘」= `invalidated_memory_units` 显式失效 + consolidation 覆盖。consolidation 是后台 job：新事实生成/更新 observation，支持 supporting/contradicting/refining，带 proof_count、source_memory_ids、history JSONB（consolidator.py:1-14，3986 行）。

**注入预算与裁剪**：`recall(budget=low|mid|high)` 映射到 thinking_budget（config.py:1126-1135），结果按 `max_tokens` 截断（search/trace.py:30），决策重排里也按 token 裁（decision_reranker.py:22,83）。**预算是 API 的一等参数**，不是配置里的一个字符数。

**失败与降级**：slim/all 两个发行包（slim 要外部 PG，all 自带），hindsight-embed 用嵌入式 Postgres + 本地 daemon 自动起停（embed/README:1-15）；store 可整体替换。降级路径散落在 2.4 万行的 memory_engine.py 里，没有单点。

**体量**：约 31 万行（api-slim 18 万、clients 8 万、control-plane 4.6 万、embed 5.5k），53 个 Python 运行时依赖，memory_engine.py 单文件 24348 行。

**它的「小核心」边界在哪**：逻辑边界清清楚楚（存储不变式 + 四臂打分 + 巩固规则），**代码边界没有**——这三件事全住在一个 2.4 万行的 engine 里，外面再糊 30 万行产品层。可迁移的边界定义是：**核心 = 存储不变式 / 召回打分公式 / 巩固判定规则；其余（provider 矩阵、降级、指标、webhook、多租户、迁移）一律不是核心。**

**值得抄**
1. **每臂先限流再融合**（fusion.py:7-27）→ recall：BM25-lite + 近因 + 标签/实体各取 top-K 再合并，防单一信号霸榜，约 10 行。
2. **RRF 代替加权和**（k=60，fusion.py:29-45）→ recall：免调权重、免归一化，多信号一视同仁，约 8 行。
3. **预算档位化**（budget→token 上限→按 max_tokens 裁）→ surface/recall：把我们的「字符上限」升成 low/mid/high 三档，少两三个配置项。

**别学**：四臂 + cross-encoder + pgvector + pg_search + Oracle 双后端 + 5 家 LLM provider（含 ChatGPT OAuth）+ worker/队列 + helm/K8s + 890 篇文档。**31 万行里没有一行是为「小巧」写的。**

> 一句话：教科书级分层（三操作 × 四臂 × RRF × 后台巩固），但每层都工业化到需要 Postgres；我们只借融合方式与预算档位，不借任何一层实现。

---

## 取舍清单（可直接执行）

| 动作 | 具体做法 | 落点 | 来源 |
|---|---|---|---|
| 抄 | 审阅态物理隔离：approved / pending 两条 JSONL，召回只开 approved | store | memory-eternal db.js:140-148 |
| 抄 | `audit.jsonl` 只记状态迁移（old→new / by / reason） | store | memory-eternal vault.js:506-551 |
| 抄 | 人设解析链：session > workspace(cwd) > default > none | config(surface) | soul-md index.js:170-190 |
| 抄 | 索引常驻 + 正文按需，预算先保索引 | recall | soul-md index.js:300-311 |
| 抄 | 压缩后回捞本会话读过的条目 | recall+capture | soul-md index.js:250-277 |
| 抄 | 捕获前机械剥噪声 + 「剥完为空」判注入 | capture | memory-eternal capture.js:51-97 |
| 抄 | 多信号 each-arm top-K 后再 RRF 融合 | recall | hindsight fusion.py:7-45 |
| 抄 | 注入预算降为 low/mid/high 三档 | surface | hindsight config.py:1126-1135 |
| 抄 | 工具目录由定义生成，不手写 | surface | tiddlywiki tools.ts:44-58 |
| 抄 | 召回回执声明 scope（收窄/扩大） | recall | tiddlywiki tools-read.ts:59-63 |
| 不抄 | SQLite 迁移 + 双表共享 id 发号器 | — | 状态机的税 |
| 不抄 | watchdog / doctor / rebuild 引导 / 健康注入 | — | 运维，占一半体量 |
| 不抄 | 16 个 wiki 工具 + 文档中枢那层 | — | 与 docs 双轨重复 |
| 不抄 | 四臂 + cross-encoder + 后台 consolidation job | — | 需要 PG 与队列 |
| 不抄 | 人设存 settings YAML 整段 markdown | — | 每次读配置带正文 |

目标形态：**store / capture / recall / judge / surface 五个模块，判定与打分是纯函数，存储是不可变追加流，召回只用已批准数据。** 我们要的是它们的「不变式」，不是它们的「行数」。
