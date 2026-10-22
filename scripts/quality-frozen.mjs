import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'

/**
 * 冻结集评测。
 *
 * 和 scripts/quality-eval.mjs 的区别，不是「语料更大」而是「不参与调参」：
 * - quality-eval.mjs 的样本是边写边改出来的，用来看改动有没有把已知场景弄坏；
 * - 这里的语料和查询都冻在 test/fixtures 里，写完就不再为了通过去改它。
 *   语料变了等于换了考卷，基线必须重测。
 *
 * 所以这个脚本只报数字，不设门禁、不许用它的结果去调权重。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const fixtures = path.join(root, 'test', 'fixtures')

const corpusFile = path.join(fixtures, 'frozen-corpus.md')
if (!fs.existsSync(corpusFile)) {
  console.error('缺少冻结语料 test/fixtures/frozen-corpus.md')
  process.exit(2)
}

// 按场景分组的查询文件由 frozen-*.json 提供，文件名前缀就是场景名
const caseFiles = fs
  .readdirSync(fixtures)
  .filter((f) => /^frozen-.*\.json$/.test(f))
  .sort()
if (caseFiles.length === 0) {
  console.error('缺少冻结查询 test/fixtures/frozen-*.json')
  process.exit(2)
}

const cases = []
for (const file of caseFiles) {
  const raw = fs.readFileSync(path.join(fixtures, file), 'utf8')
  let list
  try {
    list = JSON.parse(raw)
  } catch (e) {
    console.error(`${file} 不是合法 JSON：${e.message}`)
    process.exit(2)
  }
  if (!Array.isArray(list)) {
    console.error(`${file} 应该是数组`)
    process.exit(2)
  }
  for (const c of list) cases.push({ ...c, scene: file.replace(/^frozen-/, '').replace(/\.json$/, '') })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
fs.copyFileSync(corpusFile, dialogueFile)

consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

// 语料里明写了「换成 / 改了」的几组，要把旧条目标成被取代。
// 这不是为了让指标好看——真实系统里这些旧决定就该被淘汰。
const SUPERSEDED = new Set(['数据库选型', '部署位置', '代码风格', '编辑器'])
const recs = fs
  .readFileSync(structuredFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
// 语料文件顶部的说明文字会被当成一节固化进来（fact 取的是标题），
// 它不是记忆，丢掉，免得污染候选池。
const JUNK_FACTS = new Set(['冻结评测语料'])
const patched = recs
  .filter((r) => !JUNK_FACTS.has(r.fact))
  .map((r) => (SUPERSEDED.has(r.fact) ? { ...r, status: 'superseded' } : r))
fs.writeFileSync(structuredFile, patched.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const cfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

const byScene = new Map()
let hit1 = 0
let hit3 = 0
let mrr = 0
let answerable = 0
let staleQueries = 0
let noAnswerFp = 0
let unanswerable = 0
let totalHits = 0
let staleHitCount = 0
const failures = []

for (const c of cases) {
  if (!byScene.has(c.scene)) {
    byScene.set(c.scene, { n: 0, hit1: 0, hit3: 0, mrr: 0, ans: 0, stale: 0, fp: 0, una: 0 })
  }
  const s = byScene.get(c.scene)
  s.n += 1

  const hits = recall(cfg, c.q, Date.now() + 5000)
  const texts = hits.map((h) => h.entry.text)
  totalHits += hits.length

  const stale = (c.forbid || []).filter((f) => texts.some((t) => t.includes(f)))
  if (stale.length) {
    staleQueries += 1
    staleHitCount += stale.length
    s.stale += 1
    failures.push(`[STALE][${c.scene}] ${c.q} -> 不该出现: ${stale.join(', ')}`)
  }

  if (c.expect === null) {
    unanswerable += 1
    s.una += 1
    if (hits.length > 0) {
      noAnswerFp += 1
      s.fp += 1
      failures.push(`[NOANSWER][${c.scene}] ${c.q} -> 本该空召回，实际 ${texts.length} 条`)
    }
    continue
  }

  answerable += 1
  s.ans += 1
  const rank = texts.findIndex((t) => t.includes(c.expect))
  if (rank === 0) {
    hit1 += 1
    s.hit1 += 1
  }
  if (rank >= 0 && rank < 3) {
    hit3 += 1
    s.hit3 += 1
  }
  if (rank >= 0) {
    mrr += 1 / (rank + 1)
    s.mrr += 1 / (rank + 1)
  }
  if (rank < 0) {
    failures.push(
      `[MISS][${c.scene}] ${c.q} -> 期望「${c.expect}」，实际: ${texts.map((t) => t.slice(0, 14)).join(' | ') || '(空)'}`,
    )
  }
}

const pct = (n, d) => (d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%')

console.log('=== 冻结集基线 ===')
console.log(`样本 ${cases.length} 条（有答案 ${answerable} / 无答案 ${unanswerable}）`)
console.log('Recall@1      :', pct(hit1, answerable))
console.log('Recall@3      :', pct(hit3, answerable))
console.log('MRR           :', answerable === 0 ? 'n/a' : (mrr / answerable).toFixed(3))
console.log('受污染查询比例:', pct(staleQueries, cases.length))
console.log('过期结果占比  :', pct(staleHitCount, totalHits))
console.log('无答案误召率  :', pct(noAnswerFp, unanswerable))

console.log('\n--- 分场景 ---')
for (const [scene, s] of [...byScene].sort()) {
  console.log(
    `${scene.padEnd(18)} n=${String(s.n).padStart(3)}  R@1=${pct(s.hit1, s.ans).padStart(6)}  R@3=${pct(s.hit3, s.ans).padStart(6)}  MRR=${s.ans ? (s.mrr / s.ans).toFixed(3) : 'n/a'}  污染=${s.stale}  误召=${s.fp}`,
  )
}

if (failures.length) {
  console.log(`\n--- 失败 ${failures.length} 条 ---`)
  for (const f of failures) console.log(' ', f)
}

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

// 冻结集故意不设门禁：它的数字是用来观察的，不是用来通过的门。
// 拿它当门禁，迟早会为了让它绿而去改语料或改权重。
process.exitCode = 0
