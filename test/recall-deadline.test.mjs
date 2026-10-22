import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'

// 这个测试打的是真实实现（import '../index.js'），不是 Recall 逻辑的副本。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'))
const memoryRoot = path.join(dir, 'memory')
fs.mkdirSync(path.join(memoryRoot, '生长'), { recursive: true })

const dialogue = path.join(dir, 'dialogue.md')
// 关键词只出现在少数段落：否则 df≈N，idf≈0，分数会被 minScore 地板全部卡掉
// （这本身是真实边界：单一主题的档案检索会失效，见 README「已知限制」）
const body = Array.from({ length: 60 }, (_, i) =>
  i < 3
    ? `## 海马体 ${i} 段\n\n这是关于海马体记忆固化流程的一段说明文字，用于验证召回打分链路是否正常工作，编号 ${i}。`
    : `## 杂项 ${i} 段\n\n今天天气晴朗，路上车流不多，午饭吃了面条和青菜，下午按时完成了例行的工作，编号 ${i}。`,
).join('\n')
fs.writeFileSync(dialogue, body, 'utf8')

const cfg = {
  dialogueFile: dialogue,
  memoryRoot,
  autocaptureStore: null,
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

// 1) 正常 deadline：应该能召回到东西
const ok = recall(cfg, '海马体记忆固化流程', Date.now() + 5000)
assert.ok(Array.isArray(ok), 'recall returns array')
assert.ok(ok.length > 0, 'relevant query recalls something under a live deadline')
assert.ok(ok.length <= 3, 'topK respected')

// 2) deadline 已过期：必须放弃计算、返回空，而不是硬算到底
const before = Date.now()
const expired = recall(cfg, '海马体记忆固化流程', Date.now() - 1)
const cost = Date.now() - before
assert.deepEqual(expired, [], 'expired deadline yields no hits')
assert.ok(cost < 200, `expired deadline should bail out fast, took ${cost}ms`)

// 3) 缓存命中后重复查询结果稳定
const a1 = recall(cfg, '记忆固化', Date.now() + 5000).map((h) => h.entry.id)
const a2 = recall(cfg, '记忆固化', Date.now() + 5000).map((h) => h.entry.id)
assert.deepEqual(a1, a2, 'repeat query is stable (cache works)')

fs.rmSync(dir, { recursive: true, force: true })
console.log('recall deadline tests passed')
