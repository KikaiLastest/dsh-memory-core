import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'

// 后台摘要（P0d）的产物以前只写不读，等于纯空转。
// 这里盯两件事：
// 1) 没被对话记录收录的短小节，能通过摘要进召回池；
// 2) 已经原样进池的小节，摘要不能再复制一份。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumrecall-'))
const memoryRoot = path.join(dir, 'memory')
fs.mkdirSync(memoryRoot, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const summaryStore = path.join(dir, 'summaries.jsonl')

const shortTitle = '香菜和葱花的忌口'
const shortSummary = '主人明确说过不吃香菜，葱花可以放一点。'
const longTitle = '召回索引的构建方式'
const longBody = '这一节讲的是倒排索引怎么建，内容足够长，会被对话记录的四十字门槛正常收录进来。'

// 行号：1 是日期标题，3 是短小节，7 是长小节
fs.writeFileSync(
  dialogueFile,
  ['## 2026-10-22', '', '### ' + shortTitle, '', '不吃香菜。', '', '### ' + longTitle, '', longBody, ''].join('\n'),
  'utf8',
)

fs.writeFileSync(
  summaryStore,
  [
    JSON.stringify({ id: 's1', title: shortTitle, summary: shortSummary, keywords: ['香菜'], source_id: 'dialogue:3' }),
    JSON.stringify({ id: 's2', title: longTitle, summary: '这一节的摘要副本', keywords: ['索引'], source_id: 'dialogue:7' }),
  ].join('\n') + '\n',
  'utf8',
)

const cfg = {
  memoryRoot,
  dialogueFile,
  summaryStore,
  structuredFile: path.join(memoryRoot, '记忆', 'structured.jsonl'),
  topK: 5,
  minCoverage: 0,
  minMatched: 1,
  minRatio: 0,
  halfLifeDays: 30,
}

const hits = recall(cfg, '香菜忌口', Date.now() + 5000)
const ids = hits.map((h) => h.entry.id)

assert.ok(
  ids.some((id) => id.startsWith('sum-s1')),
  '短小节应该通过摘要进池，实际命中: ' + ids.join(', '),
)

const longHits = recall(cfg, '倒排索引构建', Date.now() + 5000)
const longIds = longHits.map((h) => h.entry.id)
assert.ok(
  !longIds.includes('sum-s2'),
  '已被原文收录的小节，摘要不该再复制一份，实际命中: ' + longIds.join(', '),
)
assert.ok(
  longIds.some((id) => id.startsWith('dialogue:')),
  '长小节仍要由原文自己命中',
)

// 行号漂移：在对话记录开头插两行，长小节从第 7 行挪到第 9 行。
// 摘要里记的还是 dialogue:7 —— 如果去重还按行号比，这份过期摘要就会被当成
// 「没收录过」重新进池，和原文撞成两份镜像，白占 topK。
const padded = '\n\n' + fs.readFileSync(dialogueFile, 'utf8')
fs.writeFileSync(dialogueFile, padded, 'utf8')

const drifted = recall(cfg, '倒排索引构建', Date.now() + 5000)
const driftedIds = drifted.map((h) => h.entry.id)
assert.ok(
  !driftedIds.includes('sum-s2'),
  '行号漂移之后，摘要仍不该重复进池，实际命中: ' + driftedIds.join(', '),
)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('summary recall tests passed')
