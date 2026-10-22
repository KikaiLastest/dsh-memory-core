# 基线冻结记录（阶段 0）

多智能体开发波次的起点。所有代理必须从这份基线出发，报告前后对比时以这里为准。

## 冻结版本

| 项 | 值 |
|---|---|
| commit SHA | `c1fa1596a85ad57f748a9d3ac4f714b6b388af19` |
| 分支 | `master` |
| 冻结数据哈希 | `2705f5607ea87deb`（frozen-corpus.md + frozen-*.json 的 sha1 前 16 位） |
| Node | 24.15.0 |
| 运行时依赖 | 0 |

**冻结集数据一旦改动，哈希就会变，所有基线数字作废。** 改数据要单独说明并重跑。

## 冻结集基线（157 条，有答案 133 / 无答案 24）

| 指标 | 值 |
|---|---|
| Recall@1 | **48.1%** |
| Recall@3 | 49.6% |
| MRR | 0.489 |
| 受污染查询比例 | 1.9% |
| 过期结果占比 | 3.3% |
| 无答案误召率 | 8.3% |

命令：`node scripts/quality-frozen.mjs`

## 开发集（12 条）

| 指标 | 值 |
|---|---|
| Recall@1 / @3 | 100% |
| MRR | 1.000 |
| 无答案误召率 | 0% |

**这组数字不能当证据。** 样本是边改算法边写出来的，它测的是「有没有把已知的那几条弄坏」。
任何声称「改进」的提交，必须报冻结集的前后对比。

## 失败构成（72 条）

| 类型 | 条数 |
|---|---|
| 空召回 | 56（78%） |
| 有结果但排序错 | 11 |
| 过期事实泄漏 | 3 |
| 无答案误召 | 2 |

详见 `docs/FAILURE-ANALYSIS.md`。

## 已知阻塞项（本轮要修的）

| 级别 | 问题 |
|---|---|
| P0 | `recallWithVerdict()` 存在，但 `agent/pre-step` 注入路径仍直接调 `recall()`，verdict 没进主路径 |
| P0 | `scan()` 闭包捕获原始查询的 `pool`，扩展重试扫同一个池子，只含扩展词的正确记忆进不了评分 |
| P1 | `benchmark-latency.mjs` 缺真实语料时静默切合成分支 |
| P1 | 冻结集没进 CI 门禁 |
| P1 | 2-gram 架构已到上限，不该继续调阈值 |

## 工作区布局

主仓库：`D:\dsh-workspace\projects\dsh-memory-core`（分支 master，**只有集成负责人能改**）
代理工作区：`D:\dsh-workspace\projects\wt-agent-1` ~ `wt-agent-10`（分支 agent-1 ~ agent-10）

每个代理在自己的 worktree 里改、测、提交，**不 push、不合并**。集成由主负责人按顺序 cherry-pick。

## 阶段 0 核对结果：契约与生产路径不一致

`CONTRACT.md` 有 5 节（检索结构 / 状态语义 / 文件所有权 / 评测口径 / 硬性规则），
**完全没有 verdict 这一节**。而 `index.js` 已经导出 `recallWithVerdict()`，
`abstain.mjs` 已经定义 `ABSTAIN_DEFAULTS` / `VERDICT` / `REASON` / `decide()`。

后果：拒答的返回形状是「实现了但没写进契约」，谁都可以改，没有恒等式测试保护。
这与 P0-1（注入路径没用 verdict）是同一个根因的两面。

集成时要补的一节（等 Agent 3 的方案定注入行为后写死）：
- `recallWithVerdict()` 的返回字段、`verdict` 三个枚举值各自的注入行为
- `evidenceStrength` 明确是启发式，**不是**校准概率，不许在文档或代码里叫 confidence
- 恒等式测试：`verdict === 'abstain'` 时注入路径必须不注入

## 任务分配表

| Agent | 职责 | 可改文件 | worktree |
|---|---|---|---|
| 1 | 检索候选生成 | `index.js` 的 recall 部分 | wt-agent-1 |
| 2 | 查询理解与词典 | `syn.mjs` | wt-agent-2 |
| 3 | 拒答与运行时集成 | `abstain.mjs`、新建集成测试 | wt-agent-3 |
| 4 | 记忆生命周期 | `status.mjs` | wt-agent-4 |
| 5 | 评测与数据治理 | `scripts/quality-*.mjs` | wt-agent-5 |
| 6 | 性能基准真实性 | `scripts/benchmark-latency.mjs` | wt-agent-6 |
| 7 | 安全与隐私 | `sanitize.mjs` | wt-agent-7 |
| 8 | 文件持久化与恢复 | `fs-safe.mjs` | wt-agent-8 |
| 9 | API 与发布包 | `package.json`、`test/pack.test.mjs` | wt-agent-9（待名额） |
| 10 | 独立红队验收 | 不改生产代码，只出报告 | wt-agent-10（待名额） |

Agent 1 和 Agent 3 都会想动注入路径，按契约 `index.js` 归集成负责人。
它们只能在自己的分支上改，集成时由负责人逐个 cherry-pick 并回归。

## 回滚点

`git reset --hard c1fa159` 可回到本基线。
主仓库另有一个 stash：`wip: 扩展候选池修复(未验证)`，是 P0 第 2 条方向的半成品，参考用，未验证。
