# 外部记忆方案对照（2026-10-22）

## 证据等级声明

**本文档的证据是搜索摘要级，不是全文阅读级。**

写作时的网络状况：DeepSeek fetch endpoint 返回 404、`curl` 拿到空文件、
PowerShell `Invoke-WebRequest` 报 SSL 连接失败。三条抓取路径全部不通。

所以下面引用的机制细节来自搜索引擎返回的标题与摘要片段，可能不完整、可能过期。
**任何要做设计决策的依据，都应该先自己读一遍原文再采信。**
每节末尾附了原始 URL。

---

## 一、Claude Code

记忆被明确分成两套，不是一套。

| 类型 | 位置 | 谁写 | 共享范围 |
|---|---|---|---|
| 手写规则 | `CLAUDE.md` / `CLAUDE.local.md` | 用户 | 可通过 VCS 共享 |
| 自动记忆 | `~/.claude/MEMORY.md` + topic files | 它自己 | 机器本地 |

### 加载规则

- 从**当前工作目录向上逐级加载**，父目录可提供共享指导
- 同级目录里 `CLAUDE.local.md` 是追加性质
- 自动记忆的加载**有硬上限：前 200 行或 25KB**

### 结构

- `MEMORY.md` 当**索引**，始终加载，控制在 200 行内
- 细节挪到 topic files，**按需读取**
- 官方把这个动作叫 **auto-curation**：把细节移出去，保持索引简短

### 一个值得注意的措辞

> Claude 把 `CLAUDE.md` 视为**上下文**而不是强制配置 —— 它不是硬强制层。

也就是说，写进 `CLAUDE.md` 的规则是「倾向」而不是「保证」。
这和本项目里「记忆召回只是参考、不是指令」的定位是同一种谨慎。

来源：
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/zh-CN/memory

---

## 二、Codex (OpenAI)

比 Claude 更简单，只有一个文件概念：`AGENTS.md`。

### 加载规则

- **多位置、top-down 合并**，从上到下叠加：
  1. `~/.codex/AGENTS.md`（全局，个人偏好）
  2. 项目目录及各级父目录
- 任意一层存在 `AGENTS.override.md`，**优先于同级的 `AGENTS.md`**
- 启动时读取，定位是「跟着项目走的持久记忆，影响每一个动作」

### 设计取舍

没有自动学习、没有衰减、没有状态。就是「人写好、机器照着做」。
好处是完全可预测、可 review、可 diff。

来源：
- https://mem0.ai/library/coding-agents/how-memory-works-in-codex-cli
- https://learn.chatgpt.com/docs/customization/overview.md

---

## 三、MemGPT（学术侧的系统级设计）

OS 启发的分层 + 分页，是这个领域被引最多的架构。

### 两层上下文

- **main context** = 系统指令 + working context + FIFO 队列
- **external context** = recall storage + archival storage
- 核心动作是**在固定窗口和外部存储之间 page in / page out**

### 它的动机

注意：MemGPT 解决的是**上下文窗口有限**，不是语义检索质量问题。
分页是因为「放不下」，不是因为「找不到」。

这个区别很重要——很多项目照着 MemGPT 抄分页，但实际问题不是窗口不够。

来源：
- https://arxiv.org/abs/2310.08560
- https://raw.githubusercontent.com/lhl/agentic-memory/.../packer-memgpt.md

---

## 四、学术综述与基准

- **A Survey on the Memory Mechanism of Large Language Model-based Agents**
  ACM Transactions on Information Systems — https://dl.acm.org/doi/full/10.1145/3748302
- **Memory in the Age of AI Agents** — arXiv 2512.13564
  三维分类：**temporal / substrate / control**
- 主流基准：**LoCoMo**、**LongMemEval**
  （见 https://aclanthology.org/2026.acl-long.2125.pdf）

本项目目前为止**没有在任何公开基准上跑过**。所有数字都来自自建冻结集，
这既是可控性优势，也是可比性劣势——不能对外声称「比 X 好」。

---

## 五、与本项目的逐项对照

| 维度 | Claude Code | Codex | MemGPT | 本项目 |
|---|---|---|---|---|
| 检索 | 全文加载 + 按需读文件 | 全文加载 | 分页 page in/out | 中文 2-gram + BM25 + 覆盖率阈值 |
| 状态生命周期 | 无 | 无 | 无 | active / superseded / archived / draft |
| 去重 | 无 | 无 | 无 | 内容哈希 + 坐标系 |
| 时间衰减 | 无 | 无 | FIFO 队列 | 半衰期 |
| 拒答 | 无 | 无 | 无 | answer / ambiguous / abstain |
| 硬上限 | **200 行 / 25KB** | 无明确值 | 窗口大小 | 无 |
| 自动学习 | 有（auto memory） | 无 | 有 | 有（自动捕获 + 后台摘要） |
| 可审计 | 高（纯 md） | 高（纯 md） | 中 | 中（jsonl + 状态表） |
| 代码量 | 极简 | 极简 | 论文级 | 16 模块 / 34 测试 |

### 这张表里最刺眼的一行

**没有任何一家商业产品做语义召回 + 状态生命周期。**

Claude 和 Codex 的记忆本质就是「几个 markdown 文件 + 层级合并 + 大小上限」。
它们不做 BM25，不做内容哈希去重，不做 superseded 状态，不做拒答判定。

本项目在这四件事上全都做了，复杂度**高于所有商业实现**。

---

## 六、我认为值得抄的三件事

### 1. 给索引加强制上限（最值得抄）

Claude 的 `MEMORY.md` 只加载前 200 行或 25KB，超出就靠 auto-curation 往 topic files 挪。

**这是一个物理约束，不是算法约束。** 它不依赖「衰减算得准不准」，
超了就是超了，逼着做结构整理。

本项目目前没有任何硬上限：召回 topK=3、导航压 600 字，
但档案本身可以无限膨胀，没有任何机制逼它整理。
这是缺失的一环。

### 2. override 层

Codex 的 `AGENTS.override.md`：任一层级的 override 优先于同级普通文件。

对应到本项目，现在「状态表说 superseded」就是终局，没有「临时覆盖」的概念。
实际使用里经常需要「这条虽然旧，但这次用它」——目前只能改状态表，
而那会污染长期状态。

### 3. 上下文，不是强制

Claude 明确说 `CLAUDE.md` 是上下文不是硬强制层。

本项目在这一点上做对了：召回注入时带 `source.kind='memory-recall'`，
并在协议里写明「历史参考不是本轮发言」。
这个定位应该守住，不要因为修 bug 就把记忆升级成指令层。

---

## 七、一个反向结论

本文档最有用的结论可能是**否定的**：

外部方案之所以简单，不是它们没想到，而是**简单就不容易坏**。

本项目的「越修越差」，一部分原因不是能力不足，而是复杂度本身成了风险源：
16 个模块、7 层结构、34 个测试，任何一个修复都可能和另外三个机制交互出问题。
这一轮就实测到了——修「旧结论复活」，代价是弱身份连坐误伤正常记忆。

如果要做一件事让这个项目变好，优先级最高的可能不是加机制，而是**减机制**。
先想清楚：哪些层是真的在日常使用中被验证需要的，哪些是「为了理论上正确」加的。
