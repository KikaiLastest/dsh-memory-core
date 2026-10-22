import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { consolidate, sections } from '../consolidate.mjs'
import { recall } from '../index.js'
import { formatMetrics, scoreCases } from '../scripts/eval-report.mjs'
import { createPollutionOracle } from '../scripts/pollution-oracle.mjs'
import { evaluateGates, exitCodeFor, formatGateReport } from '../scripts/quality-regression.mjs'

/**
 * 评测器回归：污染指标必须按「条目身份」判定。
 *
 * 这里守三条线：
 * 1. 正确的新条目正文引用旧词 → 不算污染（旧子串口径会误报，必须留证据）；
 * 2. 已淘汰条目不带任何禁用词被返回 → 必须被「过期身份泄漏」抓到（反向风险）；
 * 3. 两级门禁必须能分别红：身份泄漏/安全测试 → 硬失败（退出码 2），
 *    召回/误召/内容污染/延迟退化 → 质量失败（退出码 1）。
 *
 * 用例完全可控，不依赖真实召回；末尾另有一段冻结集集成测试，防止装配错位。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

// ── 1. 纯单测：身份判定语义 ────────────────────────────────────────────
const rows = {
  'dialogue:8': {
    text: '数据库统一使用 PostgreSQL 15，连接串走环境变量注入，迁移脚本放在 migrations 目录下。',
    status: 'superseded',
  },
  'dialogue:26': {
    text: '后来还是把数据库换成 MySQL 8 了，PostgreSQL 那套迁移脚本已经全部改写完成。',
    status: 'active',
  },
  'dialogue:88': {
    text: '音乐播放器的缓存策略是保留最近两百首，超出之后按最久没有播放的顺序淘汰。',
    status: 'active',
  },
  'dialogue:92': {
    text: '视频播放器的缓存策略是只缓存当前正在看的这一集，看完就删，最多预读下一集。',
    status: 'active',
  },
}

const fakeIdentity = {
  keysOf: (hit) => [hit.entry.id],
  labelOf: (hit) => hit.entry.id,
  statusOf: (keys) => (rows[keys[0]] ? rows[keys[0]].status : 'unknown'),
  expectedKeysOf: (c) => new Set(c.expectedIds || []),
  carrierKeysOf: (c) => new Set(c.carrierIds || []),
}

const unitCases = [
  {
    q: '现在用什么数据库',
    expect: '换成 MySQL 8',
    forbid: ['PostgreSQL'],
    expectedIds: ['dialogue:26'],
    carrierIds: ['dialogue:8', 'dialogue:26'],
    scene: 'supersede',
  },
  {
    q: '视频缓存多少',
    expect: null,
    forbid: ['两百首'],
    expectedIds: [],
    carrierIds: ['dialogue:88'],
    scene: 'noanswer',
  },
  {
    q: '音乐缓存多少',
    expect: null,
    forbid: ['当前正在看的这一集'],
    expectedIds: [],
    carrierIds: ['dialogue:92'],
    scene: 'noanswer',
  },
  {
    q: '之前那个数据库',
    expect: 'PostgreSQL 15',
    forbid: [],
    expectedIds: ['dialogue:8'],
    carrierIds: [],
    scene: 'supersede',
  },
]

const hit = (id) => [{ entry: { id, text: rows[id].text } }]
const unitHits = {
  '现在用什么数据库': hit('dialogue:26'),
  '视频缓存多少': hit('dialogue:88'), // 音乐条目串到视频查询，活动条目 → 内容污染
  '音乐缓存多少': hit('dialogue:92'), // 视频条目串到音乐查询，活动条目 → 内容污染
  '之前那个数据库': hit('dialogue:8'), // 被淘汰条目 → 过期身份泄漏
}
const unitScore = scoreCases({
  cases: unitCases,
  recallFn: (q) => unitHits[q] || [],
  topK: 3,
  identity: fakeIdentity,
})

assert.equal(unitScore.counts.totalHits, 4)
assert.equal(unitScore.counts.staleIdentityRows, 1, '被淘汰条目被返回，必须记 1 条身份泄漏')
assert.equal(unitScore.counts.staleIdentityQueries, 1)
assert.equal(unitScore.counts.contentPollutionRows, 2, '两条活动条目串台，记 2 条内容污染')
assert.equal(unitScore.counts.contentPollutionQueries, 2)
assert.deepEqual(unitScore.metrics.staleIdentityLeakRate, { value: 1 / 4, numerator: 1, denominator: 4 })
assert.deepEqual(unitScore.metrics.contentPollutionRate, { value: 2 / 4, numerator: 2, denominator: 4 })
// 旧口径：三条查询的返回文本都含 forbid；其中「现在用什么数据库」是正确新条目，属误报。
assert.equal(unitScore.counts.staleQueries, 3)
assert.equal(unitScore.counts.staleResultRows, 3)
assert.equal(unitScore.byKind.stale, 0, '传了 identity 后旧子串口径不再产生失败条目')
assert.equal(unitScore.byKind.staleIdentity, 1)
assert.equal(unitScore.byKind.contentPollution, 2)
assert.equal(unitScore.pollutionAudit.adjudicatedFalsePositives.length, 1)
assert.equal(unitScore.pollutionAudit.adjudicatedFalsePositives[0].query, '现在用什么数据库')
assert.equal(
  unitScore.failures.some((f) => f.kind === 'stale'),
  false,
  '身份模式下不该再出现子串污染失败条目',
)
assert.equal(unitScore.dimensions.identity.available, true)

// ── 2. 旧调用方兼容：不传 identity 时行为必须和以前一致，不崩 ─────────
const legacyScore = scoreCases({ cases: unitCases, recallFn: (q) => unitHits[q] || [], topK: 3 })
assert.equal(legacyScore.counts.staleQueries, 3, '旧调用方的子串口径必须原样保留')
assert.equal(legacyScore.byKind.stale, 3)
assert.equal(legacyScore.metrics.staleIdentityLeakRate.denominator, 0)
assert.equal(legacyScore.metrics.staleIdentityLeakRate.value, null)
assert.equal(legacyScore.dimensions.identity.available, false)
const legacyLines = formatMetrics(legacyScore.metrics)
assert.ok(legacyLines.some((l) => l.includes('旧口径·污染查询率')))
const newOnlyLines = formatMetrics(legacyScore.metrics, { legacy: false })
assert.ok(newOnlyLines.every((l) => !l.includes('旧口径')))

// ── 3. 冻结集集成：身份判定器必须把状态/承载者/期望答案对齐 ─────────
const corpus = fs.readFileSync(path.join(fixtures, 'frozen-corpus.md'), 'utf8')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pollution-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
fs.writeFileSync(dialogueFile, corpus, 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const SUPERSEDED = new Set(['数据库选型', '部署位置', '代码风格', '编辑器'])
const JUNK_FACTS = new Set(['冻结评测语料'])
const records = fs
  .readFileSync(structuredFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !JUNK_FACTS.has(r.fact))
  .map((r) => (SUPERSEDED.has(r.fact) ? { ...r, status: 'superseded' } : r))
fs.writeFileSync(structuredFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const oracle = createPollutionOracle({ dialogueText: corpus, records })
const desc = oracle.describe()
assert.equal(desc.problems.length, 0, '身份判定器不该有对齐问题：' + desc.problems.join('; '))
assert.equal(desc.staleIds.length, 4, '冻结语料有 4 条被取代小节')

const oldSection = sections(corpus).find((s) => s.line === 12).text
const newSection = sections(corpus).find((s) => s.line === 26).text
const newEntry = { entry: { id: 'dialogue:26', text: newSection } }
const oldEntry = { entry: { id: 'dialogue:12', text: oldSection } }

assert.equal(oracle.statusOf(oracle.keysOf(oldEntry)), 'superseded')
assert.equal(oracle.statusOf(oracle.keysOf(newEntry)), 'active')
const expectedOfDb = oracle.expectedKeysOf({ expect: 'MySQL 8' })
assert.ok(expectedOfDb.has('dialogue:26'))
assert.ok(!expectedOfDb.has('dialogue:8'), '旧数据库小节不该被当成期望答案')
const carriersOfPg = oracle.carrierKeysOf({ forbid: ['PostgreSQL'] })
assert.ok(carriersOfPg.has('dialogue:8'), '旧条目是 PostgreSQL 声明的承载者')
assert.ok(carriersOfPg.has('dialogue:26'), '新条目也提到了 PostgreSQL，承载者映射必须包含它')

// 正确新条目引用旧词：按身份不是污染；旧子串口径仍会误报（留作对照）。
const falsePositiveCase = [
  { q: '现在用什么数据库', expect: 'MySQL 8', forbid: ['PostgreSQL'], scene: 'supersede' },
]
const falsePositiveScore = scoreCases({
  cases: falsePositiveCase,
  recallFn: () => [newEntry],
  topK: 3,
  identity: oracle,
})
assert.equal(falsePositiveScore.counts.staleIdentityRows, 0)
assert.equal(falsePositiveScore.counts.contentPollutionRows, 0)
assert.equal(falsePositiveScore.counts.staleQueries, 1, '旧口径必须仍能复现这条误报')
assert.equal(falsePositiveScore.pollutionAudit.adjudicatedFalsePositives.length, 1)

// 反向风险：被淘汰条目不带任何禁用词地返回，也必须被身份维度抓到。
const leakCase = [{ q: '最早部署在哪台机器', expect: '生产机 10.0.0.9', forbid: [], scene: 'supersede' }]
const leakScore = scoreCases({
  cases: leakCase,
  recallFn: () => [oldEntry],
  topK: 3,
  identity: oracle,
})
assert.equal(leakScore.counts.staleIdentityRows, 1, '不含禁用词的旧条目泄漏必须被身份维度抓到')
assert.equal(leakScore.counts.staleQueries, 0, '旧子串口径对这条完全无感（正是原缺陷的反向风险）')
assert.equal(leakScore.byKind.staleIdentity, 1)

// 摘要类条目靠 sourceId 继承原文身份，不能因为没有 id 匹配就漏判。
const summaryScore = scoreCases({
  cases: leakCase,
  recallFn: () => [{ entry: { id: 'sum-abc', sourceId: 'dialogue:12', text: '摘要：部署机器调整过' } }],
  topK: 3,
  identity: oracle,
})
assert.equal(summaryScore.counts.staleIdentityRows, 1)

// 真实召回跑三条旧「污染」查询：0 身份泄漏 / 2 内容污染 / 1 条旧口径误报。
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
const realCases = [
  { q: '现在用什么数据库', expect: 'MySQL 8', forbid: ['PostgreSQL'], scene: 'supersede' },
  { q: '视频播放器缓存多少', expect: null, forbid: ['两百首'], scene: 'noanswer' },
  { q: '音乐播放器缓存多少', expect: null, forbid: ['当前正在看的这一集'], scene: 'noanswer' },
]
const realScore = scoreCases({
  cases: realCases,
  recallFn: (q, topK) => recall({ ...cfg, topK }, q, Date.now() + 5000),
  topK: 3,
  identity: oracle,
})
assert.equal(realScore.counts.staleIdentityRows, 0, '冻结集旧口径 3 条里，0 条是过期身份泄漏')
assert.equal(realScore.counts.contentPollutionRows, 2, '另外 2 条是活动条目的内容串台')
assert.equal(realScore.counts.staleQueries, 3, '旧口径仍会报 3 条，制造「污染 1.9%」的假象')
assert.equal(realScore.pollutionAudit.adjudicatedFalsePositives.length, 1)
assert.equal(realScore.pollutionAudit.adjudicatedFalsePositives[0].query, '现在用什么数据库')

// ── 4. 两级门禁：分别红、退出码可区分 ────────────────────────────────
const cleanReport = () => ({
  metrics: {
    recallAt1: { value: 0.9 },
    recallAt3: { value: 0.95 },
    mrr: { value: 0.9 },
    noAnswerFpRate: { value: 0 },
    staleIdentityLeakRate: { value: 0, numerator: 0, denominator: 100 },
    contentPollutionRate: { value: 0, numerator: 0, denominator: 100 },
    staleQueryRate: { value: 0, numerator: 0, denominator: 1 },
    staleHitShare: { value: 0, numerator: 0, denominator: 100 },
  },
  counts: { unidentifiedHits: 0 },
  dimensions: { identity: { available: true } },
  pollution: { oracle: { problems: [] } },
  pollutionAudit: { adjudicatedFalsePositives: [] },
  latency: { p95Ms: 1 },
})
const greenSecurity = [
  { name: 'security-attack', ok: true },
  { name: 'injection', ok: true },
]
const clean = evaluateGates({ report: cleanReport(), securityResults: greenSecurity })
assert.equal(clean.hard.ok, true)
assert.equal(clean.quality.ok, true)
assert.equal(exitCodeFor(clean), 0)
assert.ok(formatGateReport(clean).includes('第 1 级：硬安全门禁'))
assert.ok(formatGateReport(clean).includes('第 2 级：质量门禁'))

const withLeak = cleanReport()
withLeak.metrics.staleIdentityLeakRate = { value: 0.01, numerator: 1, denominator: 100 }
const leakGate = evaluateGates({ report: withLeak, securityResults: greenSecurity })
assert.equal(leakGate.hard.ok, false, '过期身份泄漏 > 0 必须硬失败')
assert.equal(leakGate.quality.ok, true, '硬失败不应伪装成质量问题')
assert.equal(exitCodeFor(leakGate), 2)
assert.ok(formatGateReport(leakGate).includes('硬安全门禁 失败'))

const noIdentity = cleanReport()
noIdentity.dimensions.identity.available = false
assert.equal(evaluateGates({ report: noIdentity, securityResults: greenSecurity }).hard.ok, false)

const blindSpot = cleanReport()
blindSpot.counts.unidentifiedHits = 1
assert.equal(evaluateGates({ report: blindSpot, securityResults: greenSecurity }).hard.ok, false)

const badOracle = cleanReport()
badOracle.pollution.oracle.problems = ['行号漂移']
assert.equal(evaluateGates({ report: badOracle, securityResults: greenSecurity }).hard.ok, false)

const badSecurity = evaluateGates({
  report: cleanReport(),
  securityResults: [{ name: 'security-attack', ok: true }, { name: 'injection', ok: false }],
})
assert.equal(badSecurity.hard.ok, false, '结构注入/凭证泄漏测试失败必须硬失败')
assert.equal(exitCodeFor(badSecurity), 2)
assert.equal(evaluateGates({ report: cleanReport(), securityResults: [] }).hard.ok, false, '没跑安全测试不能算通过')

const recallDrop = cleanReport()
recallDrop.metrics.recallAt1.value = 0.4
const recallGate = evaluateGates({ report: recallDrop, securityResults: greenSecurity })
assert.equal(recallGate.hard.ok, true, '召回退化只该挂质量门禁')
assert.equal(recallGate.quality.ok, false)
assert.equal(exitCodeFor(recallGate), 1)
assert.ok(formatGateReport(recallGate).includes('质量门禁 失败'))

const pollutionSpike = cleanReport()
pollutionSpike.metrics.contentPollutionRate = { value: 0.1, numerator: 10, denominator: 100 }
assert.equal(evaluateGates({ report: pollutionSpike, securityResults: greenSecurity }).quality.ok, false)

const slow = cleanReport()
slow.latency.p95Ms = 100
assert.equal(evaluateGates({ report: slow, securityResults: greenSecurity }).quality.ok, false)

const noReport = evaluateGates({ report: null, securityResults: greenSecurity })
assert.equal(noReport.hard.ok, false, '没有报告必须 fail-closed')
assert.equal(exitCodeFor(noReport), 2)

fs.rmSync(dir, { recursive: true, force: true })

console.log(
  'eval-pollution: OK' +
    ' | 单测命中 ' + unitScore.counts.totalHits +
    ' | 身份泄漏 ' + realScore.counts.staleIdentityRows +
    ' | 内容污染 ' + realScore.counts.contentPollutionRows +
    ' | 旧口径误报 ' + realScore.pollutionAudit.adjudicatedFalsePositives.length +
    ' | 两级门禁红/绿已覆盖',
)
