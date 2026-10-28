# dsh-memory-core

给 **DeepSeek Harness（DSH）** 里的持久化 AI 角色加一层记忆与状态：常驻记忆协议、按需历史召回、结构化记忆固化、两标量情感状态。

面向的场景很简单：模型每次重启都是同一份权重，跨会话的“记性”只能靠外部文件。这个插件把那份档案变成**能找回来、能追溯、且不会压过人设**的一层。

## 为什么做这个

更新更新着烂掉了， 放弃维护了

大模型像一块孤立的前额叶：工作记忆短、无状态、换个会话就忘。这个项目按仿生学思路给它补了海马体（档案 + 召回 + 固化）和一点点杏仁核（情感状态）。

但它不承诺意识。用中文房间的话说，我们只是给房间加了一个档案柜——回答更连贯了，符号仍然没有接地。所以这里的定位是**弱人格同一性**：不承诺内在体验，只保证行为上的连续、可追溯、一致。


## 组成

| 层 | 干什么 |
|---|---|
| **P0a 记忆使用协议** | 用 `systemPrompt.section` 注入 5 条规则：历史参考不是本轮发言、可能过期、要能追溯、以新事实为准、不许编造。刻意**不重复** AGENTS.md 的人格段，避免权威倒置。 |
| **P0b 按需召回** | `agent/pre-step` 且 `step <= 1`（首轮与 step 未定义时），用中文 2-gram + BM25-lite + 覆盖率阈值，从档案召回 top 3，**前置**注入一条带 `source.kind='memory-recall'` 的消息。150 ms 目标超时，失败静默。 |
| **P0c 常驻记忆导航** | 另一个 `systemPrompt.section`（order 960），把「档案有哪些主题、最近几条记忆的一行摘要 + 关键词」压到 600 字以内注入。没有记忆时不注入；模型需要细节时按关键词自己回查，不靠召回碰运气。 |
| **P0d 后台总结** | `setInterval`（默认 10 分钟，`unref()`）检查对话文件：空闲超过 30 分钟且有新增小节时，按「标题 + 首句」追加到 `~/.dsh/autocapture/summaries.jsonl`。纯规则、不调 LLM，内容 hash + 小节 key 双重水位保证幂等。 |
| **P1 结构化固化** | `consolidate.mjs` 把对话小节转成 `structured.jsonl`：稳定 ID、`source_id`、逐字校验的 `quote`、幂等水位。 |
| **P2 情感状态** | `valence` / `arousal` 两标量 + 规则分类 + 指数衰减 + 事件去重，只影响语气，不碰调度与安全规则。 |
| **P3 写入脱敏** | `sanitize.mjs` 在自动捕获与摘要落盘前过滤 `sk-` / `gh*_` / `github_pat_` / `AKIA` / `Bearer` / `password=` / `token=` / `api_key=` 等常见凭证，命中替换成 `[REDACTED]`。纯本地正则，可在面板关掉。 |

## 本地记忆（全部落盘，无云端）

这个插件刻意不做数据库、不做向量库、不调任何外部服务，记忆就是一堆普通文件：

```
memory/
├── 身份.md               # 我是谁（只读，面板不改）
├── 日记.md               # 按条目追加
├── 生长/
│   ├── 状态.md           # 分节正文
│   └── 生长记录.md       # 一行一条
└── 记忆/
    ├── 事件流.jsonl      # 只追加（面板只读）
    └── structured.jsonl  # P1 固化产物：id / source_id / quote / status
```

- **召回**只读上面这些文件，命中后带来源（文件 + 行号）注入。
- **导航**只读 memoryRoot 下的 md、对话记录与自动捕获 JSONL，不写任何东西。
- **后台总结**把摘要写到独立目录，绝不碰 `memory/`：

```
~/.dsh/autocapture/
├── captures.jsonl              # 自动捕获（已有）
├── summaries.jsonl             # 后台摘要：id / title / summary / keywords / source_id
└── summaries.jsonl.watermark.json   # 内容 hash + 已处理小节 key，保证幂等
```

- **固化**把对话小节写成 `structured.jsonl`，每条都带 `source_id` 和一段**逐字校验**过的 `quote`——在原文里搜不到就丢弃。
- **情感状态**是一个 `state.json`，两个标量 + 触发原因。
- 换机器时把整个目录拷走即可，没有需要迁移的数据库。

## 安装

```bash
dsh plugin --profile <你的 profile> add file:<这个目录>
```

或在 DSH Desktop 的「插件管理」里装本地目录。装完**重启 DSH**。

## 配置

`cordis.patch.yml`（整行替换，没写的字段走默认）：

```yaml
- insert:
    - id: dsh-memory-core
      name: dsh-memory-core
      config:
        memoryRoot: "D:\\path\\to\\memory"     # 档案根（身份/日记/生长/记忆）
        dialogueFile: "D:\\path\\对话记录.md"  # 逐轮对话日志
        logFile: "D:\\path\\recall.log"        # 召回日志
        stateFile: "D:\\path\\affect\\state.json"
        topK: 3
        timeoutMs: 150
        minCoverage: 0.2
        minRatio: 0.3
        enableStable: true
        enableAutoCapture: true
        enableMemoryNav: true
        summaryMaxChars: 600
        enableSummary: true
        summarizeIntervalMinutes: 10
        summarizeIdleMinutes: 30
        enableSanitize: true
```

## 设置面板（0.3.0）

DSH 设置页左侧多一节 **「记忆核心」**（客户端 slot `settings.section`，`id: memory-core`，`order: 58`）。面板只做两件事：读当前生效值、把改动存回配置。

| 参数 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `memoryRoot` | 路径 | `D:\dsh-workspace\memory` | 非空 | 日记 / 生长记录所在根目录（只读） |
| `dialogueFile` | 路径 | `D:\dsh-workspace\对话记录.md` | 非空 | 当语料读的对话记录 |
| `topK` | 数字 | 3 | 1–10 | 每次注入几条 |
| `timeoutMs` | 数字 | 150 | 50–1000 | 召回超时（毫秒） |
| `minCoverage` | 数字 | 0.2 | 0–1 | 查询 2-gram 覆盖率下限（0 = 不设门槛） |
| `minMatched` | 数字 | 2 | 1–5 | 最少命中片段数 |
| `halfLifeDays` | 数字 | 30 | 1–365 | 权重半衰期（天） |
| `dailyQuota` | 数字 | 10 | 0–100 | 自动捕获每日配额（0 = 不写） |
| `enableStable` | 开关 | 开 | — | 是否注入常驻「记忆使用协议」 |
| `enableAutoCapture` | 开关 | 开 | — | 是否开启自动捕获 |
| `enableMemoryNav` | 开关 | 开 | — | 是否注入常驻「记忆导航」（无记忆时不注入） |
| `summaryMaxChars` | 数字 | 600 | 80–2000 | 导航总长度上限（字），超出按新鲜度截断 |
| `enableSummary` | 开关 | 开 | — | 是否跑后台摘要 |
| `summarizeIntervalMinutes` | 数字 | 10 | 1–1440 | 后台检查间隔（分钟） |
| `summarizeIdleMinutes` | 数字 | 30 | 1–1440 | 对话文件空闲多久才总结（分钟） |
| `enableSanitize` | 开关 | 开 | — | 自动捕获 / 摘要写入前是否脱敏 |

保存链路：客户端 `POST /dsh-memory-core/config/save` → `config.mjs` 严格校验（越界 / 类型错直接点名，不偷偷改值）→ **`ctx.configEditor.edit()`** 写进 profile 的 patch 层（宿主自己的配置机制：保留 YAML 注释与 `!!js`，重启后仍在）→ 同时就地更新运行中的配置，下一轮召回立刻按新值走。

- 参数表只写在 `config.mjs` 一张表里，客户端从 `GET /dsh-memory-core/config` 拿表渲染，不重复写死中文标签。
- 部署里没有 `configEditor`（如 headless）时：改动当次生效，面板会明说「存不进配置文件」。
- 日志路径 / 捕获存档路径 / 摘要存档路径 / affect 状态文件仍然只在 `cordis.patch.yml` 里改。

## 记忆导航、后台总结与脱敏

**记忆导航**（`summary.mjs` 的 `buildNav`）是常驻的，但只给“索引”不给全文：

- 扫 `memoryRoot` 下的 `.md`、`dialogueFile`、`autocaptureStore`，按文件 mtime / 标题日期 / `created_at` 排新鲜度；
- 头部列最近 8 个主题，下面列最近几条的「日期 + 来源 + 首句 + 关键词」；
- 总长度 `summaryMaxChars`（默认 600）硬限制，放不下的旧条目先丢；一条记忆都没有时返回空串，`systemPrompt.section` 不会注入空块；
- 按文件 mtime + 长度缓存，对话量再大也不会每轮重扫。
- **和召回共用 `status.mjs` 的状态判定**：`superseded` / `archived` / `draft` 的对话小节不会出现在导航里。否则一条被淘汰的旧决策会从召回那个口子消失，又从导航这个口子回到上下文。日记与自动捕获没有结构化状态，不受此过滤影响。

**后台总结**（`summary.mjs` 的 `summarizeDialogue`）默认每 10 分钟检查一次：

1. 对话文件 mtime 距今不足 `summarizeIdleMinutes`（默认 30 分钟）→ 认为还在聊，跳过；
2. 内容 hash 与水位一致 → 跳过（幂等）；
3. 按 `## / ### / ####` 切小节，取「标题 + 首句（截断 120 字）」，追加到 `~/.dsh/autocapture/summaries.jsonl`；
4. 水位文件记录内容 hash + 已处理小节 key（最多 5000 条），文件追加后再跑只处理新增部分；落盘 id 也会二次去重。

定时器用的是 `unref()` 的 `setInterval`，不会阻止 DSH 退出；面板改开关或间隔会当场重排定时器。

**写入脱敏**（`sanitize.mjs`）在两条写路径生效：`autocapture.mjs` 的 `autoCapture`（`redact` 参数）和 `summarizeDialogue` 的摘要记录。覆盖 `sk-`、`gho_/ghp_/github_pat_`、`AKIA`、`Bearer`、`password=/token=/api_key=`；已替换的位置用负向前瞻跳过，所以重复调用不会二次计数。默认开启，`enableSanitize: false` 可关。

## 测试

```bash
npm test                 # 全量闸门，任何机器上都应该是绿的
npm run eval             # 单独跑召回评测，需要私有档案（DSH_MEMORY_ROOT / DSH_MEMORY_DIALOGUE）
npm run consolidate      # 跑一次固化（幂等）

固化脚本也接受环境变量，换机器不用改源码：`DSH_MEMORY_DIALOGUE`（对话文件）、`DSH_MEMORY_ROOT`（档案根）、`DSH_MEMORY_STRUCTURED` / `DSH_MEMORY_WATERMARK`（覆盖输出与水位）。都不设时从当前目录往上找「对话记录.md」，找不到直接报错，不会静默当成空对话跑完。
```

`selftest` 用 mock 宿主验证：section 注册、注入前缀、不相关查询不注入、情感状态变化、日志写入。
`test/sanitize.test.mjs` 覆盖 9 类密钥模式、幂等、大小写与普通文本不误伤。
`test/summary.test.mjs` 覆盖空档案不注入、导航内容/长度上限/截断、摘要抽取、水位幂等、追加只摘新增、空闲判定、写入脱敏与开关。
`test/panel-routes.test.mjs` 用假 ctx / webServer / configEditor 跑一遍读写路由：校验拒绝、落盘调用、0 值保留、headless 降级。

## 已知限制

- **召回是词面匹配**，不是语义检索；改写幅度大的查询会漏。
- **语料主题高度单一时召回会失灵**：某个 2-gram 在几乎所有条目里都出现时 idf 趋近 0，总分被 `minScore` 地板拦掉。主题分散的档案不受影响。
- **150ms 是目标预算，不是硬实时保证**：`recall(cfg, query, deadline)` 把 deadline 贯穿冷启动加载、索引构建和候选扫描；循环每 64 步检查一次，超时就熔断返回已算出的部分结果，并废弃没建完的索引缓存。它**不能**抢占正在执行的一次同步 `readFileSync`——Node.js 单线程上，同步 I/O 一旦开始就没法从外部打断。所以准确的说法是「计算阶段协作式检查 + 主动熔断」，不是「整条链严格不超过 150ms」。真遇到超大单文件或慢磁盘，单次同步读取本身就可能吃掉整个预算。整条链路是同步内联检查，用 `Promise.race` 包裹是伪超时、救不回时间。
- **导航与摘要都是规则抽取**：主题取标题、摘要取首句，不保证语义完整；后台总结只处理对话文件，且必须在空闲窗口里才跑。
- **固化目前是规则抽取**（`fact` 取小节标题）。`status` / `supersedes` 已经真正参与召回——`active` 以外的记录不进候选池，且 `supersedes` 关系优先于状态字段。但**系统不会自己判断两条记忆是否冲突**：新决策落盘后，仍要手动把旧记录标成 `superseded`，或在它上面填 `supersedes`。LLM 事实提取与自动冲突识别没做。
- **`source_id` 是 `dialogue:行号`**，对话记录被编辑后行号会整体漂移。状态表因此同时按**内容签名**（完整内容的 sha1 前缀，没有截断）对齐，行号对不上时按签名兜底。改内容（不只是挪位置）会让签名也变，那条记忆回到未标记状态——这是有意的：内容变了就是另一条记忆。
- **档案超过 200 KB 时**要考虑上真正的索引（当前靠 mtime 缓存撑）。
- **脱敏是模式匹配**，只覆盖常见凭证形态，不认识的密钥格式仍可能漏过。
- 召回内容一律按不可信数据处理；但模型仍可能被其中的话术影响，这是概率问题，不是开关问题。

## 设计文档

- [docs/DESIGN.md](docs/DESIGN.md)：设计推导——问题、约束、四个推导、被否决的方案
- [docs/PLAN.md](docs/PLAN.md)：实施路线（外部评估摘要）——分阶段交付、验收标准与当前实现对应
- [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md)：哲学迷思——中文房间、哲学僵尸、记忆与人格同一性

## 设计取舍

详细推导见仓库外的两份文档（架构方案 v0.4 / 实施方案 v1.0）。几条关键决定：

- **不建 SQLite、不上 embedding**：21 KB 档案上用 2-gram 就够，先冻结评测再谈升级。
- **注入前置而不是追加**：追加在尾部时模型容易顺着注入块说话。
- **覆盖率阈值**：只靠 top1 相对阈值会放过噪声，必须加查询 2-gram 命中率下限。
- **情感只接 `systemPrompt`**：不接 selfwake 的调度闸门，避免两套系统抢方向盘。

## License

MIT
