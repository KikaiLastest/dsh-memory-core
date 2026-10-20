# dsh-memory-core

给 **DeepSeek Harness（DSH）** 里的持久化 AI 角色加一层记忆与状态：常驻记忆协议、按需历史召回、结构化记忆固化、两标量情感状态。

面向的场景很简单：模型每次重启都是同一份权重，跨会话的“记性”只能靠外部文件。这个插件把那份档案变成**能找回来、能追溯、且不会压过人设**的一层。

## 为什么做这个

大模型像一块孤立的前额叶：工作记忆短、无状态、换个会话就忘。这个项目按仿生学思路给它补了海马体（档案 + 召回 + 固化）和一点点杏仁核（情感状态）。

但它不承诺意识。用中文房间的话说，我们只是给房间加了一个档案柜——回答更连贯了，符号仍然没有接地。所以这里的定位是**弱人格同一性**：不承诺内在体验，只保证行为上的连续、可追溯、一致。


## 组成

| 层 | 干什么 |
|---|---|
| **P0a 记忆使用协议** | 用 `systemPrompt.section` 注入 5 条规则：历史参考不是本轮发言、可能过期、要能追溯、以新事实为准、不许编造。刻意**不重复** AGENTS.md 的人格段，避免权威倒置。 |
| **P0b 按需召回** | `agent/pre-step` 且 `step === 1` 时，用中文 2-gram + BM25-lite + 覆盖率阈值，从档案召回 top 3，**前置**注入一条带 `source.kind='memory-recall'` 的消息。150 ms 硬超时，失败静默。 |
| **P1 结构化固化** | `consolidate.mjs` 把对话小节转成 `structured.jsonl`：稳定 ID、`source_id`、逐字校验的 `quote`、幂等水位。 |
| **P2 情感状态** | `valence` / `arousal` 两标量 + 规则分类 + 指数衰减 + 事件去重，只影响语气，不碰调度与安全规则。 |

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
```

## 设置面板（0.2.0）

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

保存链路：客户端 `POST /dsh-memory-core/config/save` → `config.mjs` 严格校验（越界 / 类型错直接点名，不偷偷改值）→ **`ctx.configEditor.edit()`** 写进 profile 的 patch 层（宿主自己的配置机制：保留 YAML 注释与 `!!js`，重启后仍在）→ 同时就地更新运行中的配置，下一轮召回立刻按新值走。

- 参数表只写在 `config.mjs` 一张表里，客户端从 `GET /dsh-memory-core/config` 拿表渲染，不重复写死中文标签。
- 部署里没有 `configEditor`（如 headless）时：改动当次生效，面板会明说「存不进配置文件」。
- 日志路径 / 捕获存档路径 / affect 状态文件仍然只在 `cordis.patch.yml` 里改。

## 测试

```bash
npm test                 # selftest + affect 单测 + 召回评测 + 参数校验 + 面板路由
npm run consolidate      # 跑一次固化（幂等）
```

`selftest` 用 mock 宿主验证：section 注册、注入前缀、不相关查询不注入、情感状态变化、日志写入。
`test/panel-routes.test.mjs` 用假 ctx / webServer / configEditor 跑一遍读写路由：校验拒绝、落盘调用、0 值保留、headless 降级。

## 已知限制

- **召回是词面匹配**，不是语义检索；改写幅度大的查询会漏。
- **固化目前是规则抽取**（`fact` 取小节标题），LLM 事实提取与冲突处理还没做。
- **档案超过 200 KB 时**要考虑上真正的索引（当前靠 mtime 缓存撑）。
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
