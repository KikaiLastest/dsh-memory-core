import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'
import { summarizeDialogue, clearSummaryCache } from '../summary.mjs'
import { loadStatusMap } from '../status.mjs'

// 端到端盯一条不变量：
// 被淘汰的事实，不得通过「摘要」这条通道重新进入召回池。
//
// 这条链路上原来有两个洞：
// 1) summary.mjs 写的 source_id 是「对话记录.md#L123」，而 structured.jsonl 存的是
//    「dialogue:123」，拿它去状态表查永远查不到；
// 2) 摘要文本压缩过，内容哈希必然对不上原文。
// 现在摘要同时带 source_id（统一格式）和 content_id（原文内容哈希）。

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumrecall-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const summaryStore = path.join(dir, 'summaries.jsonl')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

const doomed = '临时采用的旧方案'
const doomedBody = '这一版临时采用了旧的缓存方案，后来因为一致性太差被整体换掉，不要再按它来。'
const keeper = '长期沿用的新方案'
const keeperBody = '现在稳定跑着的是新的缓存方案，读写都走它，维护节奏也已经按它安排好了。'

fs.writeFileSync(
  dialogueFile,
  ['## 2026-10-22', '', '### ' + doomed, '', doomedBody, '', '### ' + keeper, '', keeperBody, ''].join('\n'),
  'utf8',
)

// 1) 固化：structured.jsonl 里出现两条记录
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = readJsonl(structuredFile)
assert.equal(recs.length >= 2, true, '固化产生记录')

// 2) 生成摘要（把文件 mtime 拨回一小时前，骗过空闲判断）
const old = new Date(Date.now() - 60 * 60 * 1000)
fs.utimesSync(dialogueFile, old, old)
const gen = summarizeDialogue(
  { dialogueFile, summaryStore, summarizeIdleMinutes: 30, enableSanitize: true },
  { now: Date.now() },
)
assert.equal(gen.ok, true, '摘要生成成功')

const summaries = readJsonl(summaryStore)
assert.ok(summaries.length >= 2, '摘要写了两条')

// 3) 来源标识必须和生产格式一致 —— 这是上一次真正踩过的坑
for (const s of summaries) {
  assert.match(s.source_id, /^dialogue:\d+$/, 'source_id 必须是 dialogue:行号，实际: ' + s.source_id)
  assert.match(s.content_id || '', /^mem-[0-9a-f]{12}$/, 'content_id 必须是原文内容哈希，实际: ' + s.content_id)
}

// 4) 把被淘汰的那条标成 superseded
const patched = recs.map((r) => (r.fact === doomed ? { ...r, status: 'superseded' } : r))
fs.writeFileSync(structuredFile, patched.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

// 5) 从对话记录里删掉那一节 —— 原文不再进池，只剩摘要这一个入口
const trimmed = fs
  .readFileSync(dialogueFile, 'utf8')
  .split('\n')
  .filter((line, i, all) => {
    const start = all.findIndex((l) => l === '### ' + doomed)
    if (start < 0) return true
    const next = all.findIndex((l, j) => j > start && /^### /.test(l))
    const end = next < 0 ? all.length : next
    return i < start || i >= end
  })
  .join('\n')
fs.writeFileSync(dialogueFile, trimmed, 'utf8')

// 5b) 身份链路本身：摘要的 content_id 必须能在状态表里查到对应状态。
// 这里断言的是「摘要知道原文已经被淘汰」，而不是碰巧因为标题去重躲过去。
const statusMap = loadStatusMap({ structuredFile })
const doomedSummary = summaries.find((s) => s.title === doomed)
assert.ok(doomedSummary, '找得到被淘汰那条的摘要')
assert.equal(
  statusMap.byContentId.get(doomedSummary.content_id),
  'superseded',
  '摘要必须能凭原文内容哈希查到 superseded，实际: ' + statusMap.byContentId.get(doomedSummary.content_id),
)

clearSummaryCache()

const cfg = {
  memoryRoot,
  dialogueFile,
  summaryStore,
  structuredFile,
  topK: 5,
  minCoverage: 0,
  minMatched: 1,
  minRatio: 0,
  halfLifeDays: 30,
}

const hits = recall(cfg, doomed, Date.now() + 5000)
const dumped = hits.map((h) => h.entry.id + '=' + h.entry.text.slice(0, 20)).join(' | ')
assert.ok(
  !hits.some((h) => String(h.entry.text).includes(doomed)),
  '被淘汰的事实不该从摘要通道回到召回池，实际: ' + dumped,
)

// 6) 对照：没被淘汰的那条仍然能通过摘要召回，证明上面不是「全都召不回」
const keepHits = recall(cfg, keeper, Date.now() + 5000)
assert.ok(
  keepHits.length > 0,
  '对照失败：有效记忆应该还能召回',
)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('summary recall tests passed')
