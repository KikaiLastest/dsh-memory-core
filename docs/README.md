# 文档索引

核心只有一处真相：代码。文档的职责是解释取舍，不是替代阅读。

## 现行文档

| 文档 | 一句话 |
|---|---|
| [DESIGN.md](DESIGN.md) | 设计推导：问题、约束、四个推导、被否决的方案 |
| [INTEGRATIONS.md](INTEGRATIONS.md) | 接入说明：弃答（abstain）/ 内容身份 / 状态过滤三个切面 |
| [OPTIMIZATION.md](OPTIMIZATION.md) | 优化方案：v1（Engram 四条）+ v2（自愈与垃圾回收） |
| [EXTERNAL-MEMORY-SURVEY.md](EXTERNAL-MEMORY-SURVEY.md) | 外部方案对照：Claude Code / Codex / MemGPT 等（摘要级证据） |
| [PHILOSOPHY.md](PHILOSOPHY.md) | 哲学迷思：中文房间、哲学僵尸、记忆与人格同一性 |
| [external/](external/) | 竞品源码速读：分层 / 存储 / 衰减 / 审计四组机制的可得与不可得 |
| [archive/](archive/) | 历史轮次：路线图、红队处置、冻结集失败分析、单轮记录 |

## 读文档的顺序

1. 先读仓库根 [README.md](../README.md) 的能力与限制。
2. 要改召回语义 → DESIGN.md + archive/FAILURE-ANALYSIS.md。
3. 要改状态/身份 → INTEGRATIONS.md。
4. 要决定「加不加某个机制」→ external/ 里先找竞品怎么做的，再回 OPTIMIZATION.md 看我们为什么这么选。

## 维护规则

- 一轮工作的过程记录不新增文档，直接进 `archive/`，命名 `ROUND-<短哈希>.md`。
- 同一主题第二篇出现时合并，不并列；合并稿在开头写清来源。
- 文档只写「为什么」，不复述「是什么」——是什么看代码和 README。
