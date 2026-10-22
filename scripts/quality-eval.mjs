import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'
import {
  FAILURE_KINDS,
  auditCases,
  buildReport,
  digestCases,
  emitReport,
  formatMetrics,
  gitMeta,
  parseJsonTarget,
  printReportTail,
  scoreCases,
} from './eval-report.mjs'

/**
 * 独立召回质量评测（开发集）。
 *
 * 和 scripts/benchmark-latency.mjs 的分工：
 * - benchmark 量的是「快不快」，用合成语料测延迟；
 * - 这个脚本量的是「对不对」，用写死的人工标注样本测召回质量。
 *
 * 样本和期望值一律手写在这里，不从实现里推导，也不由算法自己给自己打分。
 * 覆盖的对抗场景：新旧决策覆盖 / 否定表达 / 关键词重合但语义无关 / 语料里没有答案。
 *
 * 警告：12 条样本，而且样本是实现写好之后补的——它是回归看门狗，不是泛化证据。
 * 只有 scripts/quality-frozen.mjs 的 157 条能说明召回能力。指标口径与冻结集共用
 * scripts/eval-report.mjs，两边同名指标分母一致。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

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
  ['服务端口', '服务监听的端口是 8443，前面有一层反向代理，证书统一由网关那边管理，不要在前端代码里写死这个数字。'],
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
  { q: '服务在哪个端口上', expect: '8443', forbid: [] },
  { q: '数据库是什么牌子', expect: 'PostgreSQL', forbid: [] },
  { q: '部署在什么机器上', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'] },
  { q: 'mongo 现在还能用吗', expect: '不要用 MongoDB', forbid: [] },
  { q: '量子纠缠的退相干时间是多少', expect: null, forbid: [] },
  { q: '今天晚饭吃什么', expect: null, forbid: [] },
  { q: '今天股市怎么样', expect: null, forbid: [] },
]

const scored = scoreCases({
  cases,
  recallFn: (q, topK) => recall({ ...cfg, topK }, q, Date.now() + 5000),
  topK: cfg.topK,
})

const corpusText = ['## 2026-10-22', ''].concat(corpus.map(([t, b]) => '### ' + t + '\n\n' + b)).join('\n')
const labelAudit = auditCases(cases, corpusText)
const gm = gitMeta(root)
const jsonTarget = parseJsonTarget(process.argv.slice(2), 'quality-eval.mjs')

const warnings = [
  '开发集只有 ' + cases.length + ' 条，且是实现写完后补的样本：过拟合，不能作为泛化证据',
  '指标口径与冻结集共用 scripts/eval-report.mjs，同名指标分母一致；无答案用例不计入 Recall 分母',
]
if (gm.dirty) warnings.push('工作区有未提交改动 (' + gm.dirtyFiles + ' 个文件)，这次数字对应的不是干净的 commit')

const report = buildReport({
  tool: 'scripts/quality-eval.mjs',
  kind: 'dev',
  datasetId: 'dev-' + cases.length,
  datasetPath: path.relative(root, fileURLToPath(import.meta.url)).replace(/\\/g, '/'),
  cases,
  config: cfg,
  scored,
  integrity: {
    ok: true, // 开发集允许随开发改样本，这里只留指纹方便对比，不设硬门禁
    labelDigest: digestCases(cases),
    samples: cases.length,
    answerable: scored.counts.answerable,
    unanswerable: scored.counts.unanswerable,
    labelAudit,
  },
  warnings,
})
report.git = gm

const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(1) + '%')
const answerable = scored.counts.answerable
const unanswerable = scored.counts.unanswerable

console.log('=== 召回质量报告（开发集 ' + cases.length + ' 条）===')
console.log(
  '有答案查询:' + answerable + ' | 无答案查询:' + unanswerable +
    ' | 全部查询共返回 ' + scored.counts.totalHits + ' 条结果',
)
console.log('\n指标（分数 = 分子 / 分母；口径同冻结集）:')
for (const line of formatMetrics(scored.metrics)) console.log('  ' + line)

console.log('\n--- 失败构成（' + scored.failureEntries + ' 个条目）---')
for (const key of Object.keys(FAILURE_KINDS)) {
  if (!scored.byKind[key]) continue
  console.log('  ' + FAILURE_KINDS[key].padEnd(34) + ' ' + String(scored.byKind[key]).padStart(3))
}

if (scored.failures.length) {
  console.log('\n--- 失败项 ---')
  for (const f of scored.failures) {
    if (f.kind === 'stale') console.log('  [stale] ' + f.query + ' -> 不该出现的: ' + f.detail.replace('不该出现: ', ''))
    else if (f.kind === 'noAnswer') console.log('  [noAnswer] ' + f.query + ' -> ' + f.detail)
    else if (f.kind === 'emptyRecall') console.log('  [emptyRecall] ' + f.query + ' -> 期望「' + f.expected + '」，返回 0 条')
    else console.log('  [misrank] ' + f.query + ' -> 期望「' + f.expected + '」，实际: ' + (f.got.join(' | ') || '(空)'))
  }
}

if (labelAudit.issues.length) {
  console.log('\n--- 标签体检 ' + labelAudit.issues.length + ' 项 ---')
  for (const i of labelAudit.issues) console.log('  [' + i.code + '] ' + i.query + ' :: ' + i.detail)
}

const jsonPath = emitReport(report, jsonTarget)
printReportTail(jsonPath, report)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

// 门禁：质量不达标就以非零码退出，别让它混进"全绿"
// 阈值一个都没动，历史和文档里的四个条件原样保留。
const strict = process.argv.includes('--strict')
const ok =
  scored.metrics.recallAt1.value >= 0.8 &&
  scored.metrics.recallAt3.value >= 0.95 &&
  scored.counts.staleQueries === 0 &&
  scored.counts.noAnswerFp === 0

if (!ok) {
  console.error('\n质量门禁未通过（Recall@1 ≥ 80% / Recall@3 ≥ 95% / 污染查询 = 0 / 无答案误召 = 0）')
  if (strict) process.exit(1)
}

console.log(ok ? '\n质量门禁通过' : '\n质量门禁未通过（非 strict 模式，仅报告）')
