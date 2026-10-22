import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'

/**
 * 独立召回质量评测。
 *
 * 和 scripts/benchmark-latency.mjs 的分工：
 * - benchmark 量的是「快不快」，用合成语料测延迟；
 * - 这个脚本量的是「对不对」，用写死的人工标注样本测召回质量。
 *
 * 样本和期望值一律手写在这里，不从实现里推导，也不由算法自己给自己打分。
 * 覆盖的对抗场景：新旧决策覆盖 / 否定表达 / 关键词重合但语义无关 / 语料里没有答案。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

// 每个小节都写到 40 字以上，否则固化与召回两边都会把它当碎片丢掉
const corpus = [
  ['旧的部署目标', '早期决定把服务先部署到测试机 10.0.0.5 上跑一段时间，确认没有问题再考虑切换到正式环境。'],
  ['新的部署目标', '后来改主意了，服务直接部署到生产机 10.0.0.9，测试机那台不再使用，相关的配置也已经全部迁移过去。'],
  ['数据库选型', '数据库统一使用 PostgreSQL 15，连接串走环境变量注入，不写死在代码里，迁移脚本放在 migrations 目录下统一管理。'],
  ['被否决的方案', '不要用 MongoDB，之前试过一次，查询一致性达不到要求，后面所有新服务都不再考虑这个选项，已经写进技术选型规范。'],
  ['音乐播放器缓存', '音乐播放器的缓存策略是保留最近两百首，超出之后按最久未播放的顺序淘汰，缓存目录放在用户的可写数据目录下面。'],
]

fs.writeFileSync(
  dialogueFile,
  ['## 2026-10-22', ''].concat(corpus.flatMap(([title, body]) => ['### ' + title, '', body, ''])).join('\n'),
  'utf8',
)

// 固化，然后把「旧的部署目标」标成被新目标取代
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = fs
  .readFileSync(structuredFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const patched = recs.map((r) => (r.fact === '旧的部署目标' ? { ...r, status: 'superseded' } : r))
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

// 人工标注：expect 必须命中，forbid 一条都不许出现，expect 为空表示语料里没答案
const cases = [
  { q: '部署到哪一台机器', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'] },
  { q: '服务跑在什么环境上', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'] },
  { q: '数据库用的什么', expect: 'PostgreSQL', forbid: [] },
  { q: '还能不能用 mongo', expect: '不要用 MongoDB', forbid: [] },
  { q: '音乐缓存保留多少首', expect: '最近两百首', forbid: [] },
  { q: '量子纠缠的退相干时间是多少', expect: null, forbid: [] },
  { q: '今天晚饭吃什么', expect: null, forbid: [] },
]

let hit1 = 0
let hit3 = 0
let mrrSum = 0
let staleHits = 0
let noAnswerFp = 0
const failures = []

for (const c of cases) {
  const hits = recall(cfg, c.q, Date.now() + 5000)
  const texts = hits.map((h) => h.entry.text)

  // 过期记忆是否漏回来：这条不计入 recall，单独算 stale
  const stale = c.forbid.filter((f) => texts.some((t) => t.includes(f)))
  if (stale.length) {
    staleHits += 1
    failures.push(`[STALE] ${c.q} -> 不该出现的: ${stale.join(', ')}`)
  }

  if (c.expect === null) {
    if (hits.length > 0) {
      noAnswerFp += 1
      failures.push(`[NOANSWER-FP] ${c.q} -> 本该空召回，实际命中 ${texts.length} 条`)
    }
    continue
  }

  const rank = texts.findIndex((t) => t.includes(c.expect))
  if (rank === 0) hit1 += 1
  if (rank >= 0 && rank < 3) hit3 += 1
  if (rank >= 0) mrrSum += 1 / (rank + 1)
  if (rank < 0) failures.push(`[MISS] ${c.q} -> 期望包含「${c.expect}」，实际: ${texts.map((t) => t.slice(0, 12)).join(' | ') || '(空)'}`)
}

const answerable = cases.filter((c) => c.expect !== null).length
const unanswerable = cases.length - answerable
const pct = (n, d) => (d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%')

console.log('=== 召回质量报告 ===')
console.log('有答案查询:', answerable, '| 无答案查询:', unanswerable)
console.log('Recall@1      :', pct(hit1, answerable))
console.log('Recall@3      :', pct(hit3, answerable))
console.log('MRR           :', answerable === 0 ? 'n/a' : (mrrSum / answerable).toFixed(3))
console.log('过期记忆漏回率:', pct(staleHits, cases.length))
console.log('无答案误召率  :', pct(noAnswerFp, unanswerable))

if (failures.length) {
  console.log('\n--- 失败项 ---')
  for (const f of failures) console.log(' ', f)
}

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

// 门禁：质量不达标就以非零码退出，别让它混进"全绿"
const strict = process.argv.includes('--strict')
const ok =
  hit1 / answerable >= 0.8 &&
  hit3 / answerable >= 0.95 &&
  staleHits === 0 &&
  noAnswerFp === 0

if (!ok) {
  console.error('\n质量门禁未通过（Recall@1 ≥ 80% / Recall@3 ≥ 95% / 过期漏回 = 0 / 无答案误召 = 0）')
  if (strict) process.exit(1)
}

console.log(ok ? '\n质量门禁通过' : '\n质量门禁未通过（非 strict 模式，仅报告）')
