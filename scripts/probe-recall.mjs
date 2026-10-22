import path from 'node:path'
import { recall } from '../index.js'

// 人工探针：拿几个真实查询看召回效果，不做断言，也不进 npm test。
// 之前它叫 test/recall.test.mjs 但没有任何断言，还复制了一份实现（阈值都和真的不一样），
// 挂在测试链里只会让人以为「有测过」。现在直接打真实 recall。

const root = process.env.DSH_MEMORY_ROOT || path.join(process.cwd(), 'memory')
const cfg = {
  dialogueFile: process.env.DSH_MEMORY_DIALOGUE || path.join(process.cwd(), '对话记录.md'),
  memoryRoot: root,
  autocaptureStore: null,
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['按顺序开发啊，现在功能完全实现了吗', '大肥鱼', '记忆档案', 'QQ 机器人', 'zzzz乱码']

for (const q of queries) {
  const hits = recall(cfg, q, Date.now() + 1000)
  console.log(`Q: ${q} => ${hits.length} hits`)
  for (const h of hits) {
    console.log(
      `   ${h.entry.id} score ${h.score.toFixed(3)} cov ${h.coverage.toFixed(2)} | ${h.entry.text.slice(0, 42).replace(/\s+/g, ' ')}`,
    )
  }
}
