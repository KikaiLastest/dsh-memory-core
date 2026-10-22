# 优化方案（v1 · v2 合并）

两轮优化的合并稿：v1 是从 Engram 借来的四条，v2 是记忆自愈与垃圾回收。原文逐字保留，只把标题降了一级。

## v1：从 Engram 借来的四条

> 触发：读完 DeepSeek《Conditional Memory via Scalable Lookup》（Engram）之后，对照本插件找出的优化点。
> 状态：待评审，未实现。

### 一、现状的三个问题

1. **每轮都在重建索引**：`recall()` 每次读 4 个文件、切条目、现算 IDF 和 BM25。虽然加了 mtime 缓存，但仍是"全量扫一遍"的 O(N)。Engram 的立场很明确：静态记忆该用查表，不该让计算层每轮重建。
2. **评测是单点**：只有 `recall@3 = 100%`（46 条标题当 query）这一个数，没有对照组，不知道哪个设计选择真正起作用。
3. **长尾召回差**：只出现一次的专有名词、型号、人名，2-gram 权重被 idf 抬高但覆盖率低，容易被阈值丢掉。

### 二、四条优化

#### 1. 倒排优先，BM25 兜底

- 加载条目时顺手建 `2-gram → Set<entryId>` 的倒排表（内存 Map，跟 mtime 缓存一起失效）。
- 查询时先拆 2-gram，取倒排并集得到**候选集**；只对候选算 BM25 + 覆盖率。
- 候选为空时才退回全量 BM25（兼作兜底）。
- 预期：把主路径从 `O(条目数)` 降到 `O(候选数)`，档案越大收益越明显。

#### 2. 热冷分层

- 热条目：最近 7 天被召回过的 entryId，常驻内存（含原文片段）。
- 冷条目：只留倒排键，原文按需从磁盘读（用记录的 offset/length 切片）。
- 对应 Engram 把大 embedding 表 offload 到 host memory 的思路：小档案无所谓，200 KB 以上开始有意义。

#### 3. 长尾关键词兜底

- 单独维护一张"专有词表"：英文词、数字型号、连续大写、`@` / `-` 连接的标识符。
- 查询命中专有词时，直接按词查一张 `token → entryId` 表，绕过 2-gram 的覆盖率阈值。
- 目的：修"只出现一次的专名召回不回来"。

#### 4. 评测矩阵（iso 对照）

同一批 query（46 条标题 + 20 条人工改写 + 10 条长尾专名），跑四组：

| 组 | 检索方式 |
|---|---|
| A | 纯 2-gram 重叠（最原始） |
| B | BM25-lite（当前线上） |
| C | 倒排候选 + BM25 |
| D | C + 长尾关键词兜底 |

指标：`recall@1`、`recall@3`、p50/p95 延迟、内存占用。只有 C/D 在延迟和长尾上有明显改善，才替换主路径。

### 三、明确不做的

- **不上 embedding**：结论未变，21 KB 档案上向量检索是过度设计。
- **不做 2-bit 量化**：那是 Engram 级别的大表（203 GB → 51 GB）才需要的手段，我们的倒排表在 KB 级。
- **不改注入流程**：前置注入、来源标记、超时降级都保持。

### 四、预期收益与风险

- 延迟：主路径预计从 ~6 ms 降到 ~2 ms（候选集通常 < 10 条）。
- 长尾：专名召回从"经常丢"变成"能命中"。
- 风险：倒排的内存随档案线性增长，需要在 200 KB 以上时观察；候选集为空时的兜底路径必须有测试。

### 五、实现顺序

1. 先写评测矩阵（A/B/C/D），拿到基线数据；
2. 再实现倒排（C），跑同一批 query 对比；
3. 然后长尾兜底（D）；
4. 热冷分层最后做，取决于 200 KB 场景是否真实出现。

### 六、外部评审与实测结果

Gemini 的评审结论是「需改」：方向对，但砍掉过度设计。**它说对了。**

- 热冷分层：过度设计，21 KB 全驻内存才几百 KB，搞磁盘切片反而多 I/O 与编码 bug。
- 独立专名词表：维护地狱，且绕过覆盖率阈值会让偶然命中的低质条目冲顶。
- 倒排：有收益但不是二阶段架构，只需预存 `entry.tf` + `gramIndex`。

#### 实测（48 条条目，46 条正样本 + 10 条负样本 + 5 条干扰）

| 组 | rec@1 | rec@3 | 负样本误召 | 耗时 |
|---|---|---|---|---|
| A 纯覆盖率 | 100% | 100% | 2/10 | 3 ms |
| B BM25 全量 | 97.8% | 100% | 0/10* | 4 ms |
| C 倒排 + BM25 | 97.8% | 100% | 0/10* | 2 ms |

\* 两组都加了 `minMatched >= 2` 过滤。

#### 结论

1. **倒排在这个规模收益微弱**（4 ms → 2 ms），不值得复杂化；已实现但保留全量兜底，当扩展路径。
2. **真正有效的是 `minMatched >= 2`**：负样本误召从 2/10 降到 0/10，召回一毛没掉。原因是短查询只有 3–5 个 2-gram，命中 1 个就过 0.2 覆盖率阈值——“无聊死了”就是靠一个“死了”混进去的。
3. **评测矩阵本身是最有价值的产出**：它证明了“单点 rec@3 100%”没有参考意义——三组都是 100%，差异全在误召和延迟上。
4. 热冷分层与专名表按评审意见**放弃**。

#### 已落地的变更

- `loadCached` 预存 `entry.tf`、`byId`、`gramIndex`；`scoreEntry` 不再每次现拆 2-gram。
- `recall` 走倒排候选，候选为空退全量。
- 新增 `minMatched: 2` 配置。
- 评测集加入 10 条负样本与 5 条干扰 query。

## v2：记忆自愈与智能垃圾回收


> 面向生产环境的 Agent 长期记忆治理：解决碎片无限堆积（记忆熵增）、新旧事实冲突（知识漂移）、以及召回相互矛盾导致模型逻辑错乱的行业级顽疾。

---

## 一、现状瓶颈与痛点诊断

当前 `dsh-memory-core` 已具备基本的启发式自动捕获（`autocapture.mjs`）、指数时间衰减（`decay.mjs`）和基于 2-gram/BM25 的前置召回注入（`index.js`），但存在以下核心隐患：

1. **单向线性堆积（无 GC 机制）**：
   - 现有的 `autoCapture` 每次命中规则就向 `.jsonl` 追加一行，缺乏淘汰与合并机制。长期对话后文件膨胀，检索复杂度上升；
2. **事实缺乏拓扑与语义归一（无 Fact Key）**：
   - 记录仅保存纯文本 `text`，未抽离出结构化键。导致同一事实的不同表述无法相互关联；
3. **知识漂移与矛盾打架（致命漏洞）**：
   - 示例：10月1日用户说“我平时只喝冰美式”，10月10日说“胃疼以后改喝热牛奶”。在后续关于“喝什么”的提问中，两条包含相同关键词的记录得分皆极高，导致两条截然矛盾的事实同时注入上下文，引发 Agent 逻辑混乱或胡言乱语；
4. **低价值碎片污染上下文**：
   - 大量过期的临时排障、一次性环境配置在衰减至极低权重后依然驻留库中，占据候选名额。

---

## 二、2.0 架构升级目标

- **事实时效覆盖（Temporal Supersede）**：新事实自动注销旧事实，召回时单事实键保证全局唯一最新；
- **离线智能垃圾回收（Memory GC）**：低权重碎片冷归档、碎片聚类压实（Compaction）；
- **零外部重依赖**：纯本地轻量执行，算法无外部重型向量库/C++编译依赖，零破坏前缀缓存；
- **零数据风险（Zero Data Loss）**：GC 执行前原子镜像快照，采用标记软注销（Soft-Deprecate），支持一键还原。

---

## 三、核心模块与数据结构设计

### 1. 结构化事实元模型（Unified Fact Schema）

在原本单一的 `text` 上引入事实键与版本链：

```json
{
  "id": "cap-7f8a9b2c",
  "type": "fact",
  "text": "主人胃不好，平时只喝热牛奶，不要给他推荐冰美式。",
  "fact_key": "user.preference.drink",      // 核心：事实键（对象.类别.方面）
  "value_summary": "热牛奶（禁冰美式）",
  "status": "active",                       // active (当前有效) | superseded (已被取代) | archived (冷归档)
  "supersedes": "cap-1a2b3c4d",             // 指向被它取代的旧事实 ID
  "created_at": "2026-10-21T10:00:00Z",
  "updated_at": "2026-10-21T10:00:00Z",
  "initial_weight": 1.0,
  "decay_half_life_days": 30,
  "permanent": false,
  "confidence": 0.95
}
```

### 2. 事实键解析与冲突消解（Conflict Arbitrator）

- **归一化算法（`lib/fact-key.mjs`）**：
  采用前缀词典映射 + 实体提取规则，将自然语言自动映射到层次化事实键：
  - “我的名字叫小明” → `user.profile.name`
  - “我不吃香菜” → `user.preference.food_taboo`
  - “项目的默认端口改成 8080” → `env.project.port`
- **时效覆盖原则**：
  当新写入的记忆带有相同的 `fact_key` 时，系统自动执行收敛：
  - 新记录的 `status` 设为 `active`；
  - 旧记录的 `status` 自动置为 `superseded`，并将新记录 ID 写入旧记录的 `superseded_by`；
  - **检索层硬拦截**：`index.js` 在 BM25 计算前，直接过滤掉所有 `status !== 'active'` 的记录，新旧冲突在入模前 100% 阻断。

### 3. 双模垃圾回收管道（Garbage Collection Pipeline）

在 `projects/dsh-memory-core/` 中新增 `gc.mjs` 模块：

```text
[原始记忆库 captures.jsonl]
           │
           ▼
┌─────────────────────────────────┐
│     轻量实时 GC (Tick-Level)     │ ── 快速 O(1) 哈希去重、同 Key 就地软注销
└─────────────────────────────────┘
           │
           ▼ (每日夜间谷时或系统静默触发)
┌─────────────────────────────────┐
│     谷时深度整理工 (Deep GC)      │
│  ├─ 1. 原子快照备份 (.backup/)  │
│  ├─ 2. 枯萎剪枝 (Weight < 0.05) │ ──> 移入 cold_archive.jsonl
│  ├─ 3. 碎片压实 (Compactor)     │ ──> 3条零散记录合并为1张结构卡
│  └─ 4. 生成健康度体检报告        │
└─────────────────────────────────┘
```

#### 具体实现函数（伪代码规范）：

```javascript
// projects/dsh-memory-core/gc.mjs
export async function runMemoryGC(options) {
  const { storePath, archivePath, halfLifeDays = 30, pruneThreshold = 0.05 } = options;
  
  // 1. 写前安全快照
  await createSnapshotBackup(storePath);
  
  const records = readCaptureStore(storePath);
  const activeRecords = [];
  const archivedRecords = [];
  
  // 2. 按事实键分组，保留最新有效版本
  const keyGroups = groupBy(records, 'fact_key');
  for (const [key, group] of Object.entries(keyGroups)) {
    if (key && key !== 'generic') {
      group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      // 最新一条保持 active
      group[0].status = 'active';
      // 其余全部标为 superseded
      for (let i = 1; i < group.length; i++) {
        group[i].status = 'superseded';
        group[i].superseded_by = group[0].id;
      }
    }
  }

  // 3. 枯萎度计算与剪枝
  const now = Date.now();
  for (const r of records) {
    const elapsedDays = (now - new Date(r.created_at).getTime()) / 86400000;
    const currentWeight = r.permanent ? 1.0 : decayWeight(r.initial_weight, elapsedDays, halfLifeDays);
    
    // 过期且已被取代、或权重极其微弱且非永久者，移入冷归档
    if (r.status === 'superseded' || (currentWeight < pruneThreshold && !r.permanent)) {
      archivedRecords.push({ ...r, status: 'archived', archived_at: new Date().toISOString() });
    } else {
      activeRecords.push(r);
    }
  }

  // 4. 原子重写主库，并将废弃数据追加写入冷库
  atomicWriteStore(storePath, activeRecords);
  appendStore(archivePath, archivedRecords);

  return {
    beforeCount: records.length,
    activeCount: activeRecords.length,
    prunedCount: archivedRecords.length,
    compressionRatio: ((1 - activeRecords.length / records.length) * 100).toFixed(1) + '%'
  };
}
```

### 4. 前端监控：记忆健康度面板扩展（Client HUD）

在 `client.js` 的设置选项卡中新增 **「记忆健康度看板」**：
- **实时健康分（0~100）**：基于冲突率、陈旧碎片率与冗余度综合打分；
- **一键体检与整理按钮**：允许用户随时点击“立即整理与消解冲突”；
- **冲突消解审计表**：清晰列出“哪条记忆在何时被哪条新记忆取代”，一清二楚，支持点选回滚。

---

## 四、落地实施计划（三步走）

| 阶段 | 核心任务 | 交付物 | 风险控制 |
|---|---|---|---|
| **第一步：事实键注入与召回过滤** | 在 `autocapture.mjs` 中加入 `extractFactKey`，在 `index.js` 召回逻辑中加入 `status === 'active'` 过滤 | 消除当前所有新旧记忆冲突打架 | 保持旧数据兼容，无键记录回落为泛化事实 |
| **第二步：实现 GC 核心引擎** | 新建 `gc.mjs`，实现原子快照、时效覆盖收敛、枯萎剪枝与冷库转储 | 彻底控制记忆库体积膨胀 | 每次执行前必须保存带时间戳的 `.bak` |
| **第三步：定时任务与前端看板打通** | 在 `index.js` 注册静默定时器（每日凌晨或空闲时调用 `runMemoryGC`），在 `client.js` 呈现可视化健康度 | 完整的全自动自愈记忆闭环 | 支持开关一键关闭自动 GC |
