import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixtures = path.join(root, 'test', 'fixtures')
const corpusFile = path.join(fixtures, 'frozen-corpus.md')
const files = fs.readdirSync(fixtures).filter((f) => /^frozen-.*\.json$/.test(f)).sort()
const cases = []
for (const file of files) {
  const list = JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'))
  for (const c of list) cases.push({ ...c, scene: file.replace(/^frozen-/, '').replace(/\.json$/, '') })
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
fs.copyFileSync(corpusFile, dialogueFile)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const SUPERSEDED = new Set(['数据库选型', '部署位置', '代码风格', '编辑器'])
const JUNK = new Set(['冻结评测语料'])
fs.writeFileSync(structuredFile, recs.filter((r) => !JUNK.has(r.fact)).map((r) => (SUPERSEDED.has(r.fact) ? { ...r, status: 'superseded' } : r)).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const cfg = { memoryRoot, dialogueFile, structuredFile, topK: 3, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30 }

const out = { noAnswer: [], answerable: [] }
for (const c of cases) {
  const r = recallWithVerdict({ ...cfg, topK: 3 }, c.q, Date.now() + 5000)
  const row = {
    scene: c.scene, q: c.q, expect: c.expect,
    verdict: r.verdict, reason: r.reason, strength: r.evidenceStrength,
    hits: r.hits.map((h) => ({ score: +h.score.toFixed(2), cov: h.coverage, matched: h.queryMatched, id: h.entry.id, fact: h.entry.fact || null, text: String(h.entry.text).slice(0, 120) })),
  }
  if (c.expect == null) out.noAnswer.push(row)
  else out.answerable.push(row)
}
const acc = (rows) => rows.filter((r) => r.verdict === 'answer').length
const amb = (rows) => rows.filter((r) => r.verdict === 'ambiguous').length
const ab = (rows) => rows.filter((r) => r.verdict === 'abstain').length
console.log(JSON.stringify({
  cases: cases.length, answerable: out.answerable.length, unanswerable: out.noAnswer.length,
  noAnswerVerdicts: { answer: acc(out.noAnswer), ambiguous: amb(out.noAnswer), abstain: ab(out.noAnswer) },
  answerableVerdicts: { answer: acc(out.answerable), ambiguous: amb(out.answerable), abstain: ab(out.answerable) },
}, null, 2))
console.log('--- 无答案样本被判 answer 的 ---')
for (const r of out.noAnswer.filter((x) => x.verdict === 'answer')) {
  console.log(JSON.stringify(r, null, 2))
}
fs.writeFileSync(path.join(dir, 'dump.json'), JSON.stringify(out, null, 2))
console.log('DUMP ' + path.join(dir, 'dump.json'))
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
