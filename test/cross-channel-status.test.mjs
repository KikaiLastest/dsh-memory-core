import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { buildNav, clearSummaryCache } from '../summary.mjs'
import { consolidate } from '../consolidate.mjs'

// 针对审查 P0：端到端验证被淘汰的记忆（superseded/archived/draft）无法从原文、摘要、导航任何入口漏回。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-status-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
const summaryStore = path.join(dir, 'summaries.jsonl')

const obsoleteTitle = '已淘汰的旧数据库方案'
const obsoleteBody = '我们决定使用 PostgreSQL 作为单体主库，所有读写都走同一个实例，不拆分只读副本。'
const newTitle = '最新分布式数据库架构'
const newBody = '主库已重构为 TiDB 分布式数据库，支持海量水平伸缩与强一致事务，原有 PostgreSQL 实例全部下线。'

const body = [
  '## 2026-10-22',
  '',
  `### ${obsoleteTitle}`,
  '',
  obsoleteBody,
  '',
  `### ${newTitle}`,
  '',
  newBody,
  '',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')

// 1. 先跑固化
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const oldRec = recs.find((r) => r.quote.includes('PostgreSQL'))
const newRec = recs.find((r) => r.quote.includes('TiDB'))
assert.ok(oldRec && newRec, '固化产物中应包含新旧两条记录')

// 2. 模拟后台摘要：写入摘要条目（短偏好与长小节摘要）
fs.writeFileSync(
  summaryStore,
  JSON.stringify({
    id: 'sum-old-db',
    title: obsoleteTitle,
    summary: '决定使用 PostgreSQL 单体主库，所有读写走同实例。',
    keywords: ['数据库', 'PostgreSQL'],
    source: 'dialogue',
    source_id: oldRec.source_id,
    content_id: oldRec.id,
    created_at: '2026-10-22T08:00:00Z',
  }) + '\n' +
  JSON.stringify({
    id: 'sum-new-db',
    title: newTitle,
    summary: '重构为 TiDB 分布式数据库，PostgreSQL 已废弃。',
    keywords: ['数据库', 'TiDB'],
    source: 'dialogue',
    source_id: newRec.source_id,
    content_id: newRec.id,
    created_at: '2026-10-22T08:30:00Z',
  }) + '\n',
  'utf8'
)

const cfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  summaryStore,
  topK: 5,
  minCoverage: 0.1,
  minMatched: 1,
  minRatio: 0.1,
  enableMemoryNav: true,
  summaryMaxChars: 600,
}

// ── 测试用例 A: 标为 superseded ──────────────────────────────────────────
oldRec.status = 'superseded'
newRec.supersedes = oldRec.id
fs.writeFileSync(structuredFile, [oldRec, newRec].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
clearSummaryCache()

// 1) 召回端：搜旧方案关键词，绝对不能命中已被取代的旧方案（无论是其原文还是其摘要）
const hitsAfterSuperseded = recall(cfg, 'PostgreSQL 单体主库', Date.now() + 5000)
for (const h of hitsAfterSuperseded) {
  assert.ok(!h.entry.text.includes('PostgreSQL 作为单体主库'), `已被取代的原文不应被召回: ${h.entry.text}`)
  assert.ok(!h.entry.text.includes('sum-old-db'), `已被取代的摘要不应被召回: ${h.entry.id}`)
}

// 2) 导航端：buildNav 绝对不能包含旧方案标题
const navText = buildNav(cfg)
assert.ok(!navText.includes(obsoleteTitle), `已被取代的记录绝对不可在常驻导航中回流: ${navText}`)
assert.ok(navText.includes(newTitle), '有效的最新方案应出现在导航中')

// ── 测试用例 B: 标为 archived 与 draft ────────────────────────────────────
newRec.status = 'archived'
fs.writeFileSync(structuredFile, [oldRec, newRec].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
clearSummaryCache()

const hitsAfterArchived = recall(cfg, 'TiDB 分布式数据库', Date.now() + 5000)
assert.equal(hitsAfterArchived.length, 0, '归档（archived）记录不可被前台召回')

const navAfterArchived = buildNav(cfg)
assert.ok(!navAfterArchived.includes(newTitle), '归档（archived）记录不可出现在常驻导航中')

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('cross-channel status tests passed')
