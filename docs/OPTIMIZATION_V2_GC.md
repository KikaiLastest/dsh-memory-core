# dsh-memory-core 2.0 · 记忆自愈与智能垃圾回收引擎（Memory-GC）架构方案

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
