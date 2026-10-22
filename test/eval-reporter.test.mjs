import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FROZEN_MANIFEST,
  assertCases,
  auditCases,
  digestCases,
  digestFrozenDir,
  formatMetrics,
  scoreCases,
  verifyFrozen,
} from '../scripts/eval-report.mjs'

/**
 * 评测脚本自身的测试。
 * 目的不是测召回，是测「评测会不会骗人」：口径分母、空召回独立计数、
 * 标签形状（空串 expect 的作弊口子）、以及冻结集指纹对改标签/删样本的敏感度。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

// --- 用例与假 recall：完全可控，不碰真实算法 ---
const corpus = '生产机 10.0.0.9 在用，测试机 10.0.0.5 已停用'
const cases = [
  { q: 'Q1 命中第一条且带污染', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'], scene: 'a' },
  { q: 'Q2 命中第三条', expect: '第三条', forbid: [], scene: 'a' },
  { q: 'Q3 一条都没有', expect: '生产机 10.0.0.9', forbid: [], scene: 'b' },
  { q: 'Q4 有结果但不对', expect: '根本不存在', forbid: [], scene: 'b' },
  { q: 'Q5 无答案却误召', expect: null, forbid: [], scene: 'c' },
  { q: 'Q6 无答案且空召回', expect: null, forbid: [], scene: 'c' },
  { q: 'Q7 排序错且污染', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'], scene: 'a' },
  { q: 'Q8 空召回且无污染', expect: '生产机 10.0.0.9', forbid: ['测试机 10.0.0.5'], scene: 'a' },
]

const fakeHits = {
  'Q1 命中第一条且带污染': [
    '生产机 10.0.0.9 在用',
    '测试机 10.0.0.5 已停用',
    '测试机 10.0.0.5 也停用',
  ],
  'Q2 命中第三条': ['无关甲', '无关乙', '这里是第三条'],
  'Q3 一条都没有': [],
  'Q4 有结果但不对': ['无关内容'],
  'Q5 无答案却误召': ['无关内容'],
  'Q6 无答案且空召回': [],
  'Q7 排序错且污染': ['测试机 10.0.0.5 早就停了'],
  'Q8 空召回且无污染': [],
}
const scored = scoreCases({
  cases,
  recallFn: (q) => (fakeHits[q] || []).map((text) => ({ entry: { text } })),
  topK: 3,
})

// 分母：有答案 6 条（Q1/Q2/Q3/Q4/Q7/Q8），无答案 2 条，样本 8 条
assert.equal(scored.counts.samples, 8)
assert.equal(scored.counts.answerable, 6)
assert.equal(scored.counts.unanswerable, 2)
assert.deepEqual(scored.metrics.recallAt1, { value: 1 / 6, numerator: 1, denominator: 6 })
assert.deepEqual(scored.metrics.recallAt3, { value: 2 / 6, numerator: 2, denominator: 6 })
assert.equal(scored.metrics.mrr.numerator.toFixed(3), '1.333')
// 空召回必须独立于 MISS：Q3/Q8 是空召回，Q4/Q7 是排错
assert.deepEqual(scored.metrics.emptyRecallRate, { value: 2 / 6, numerator: 2, denominator: 6 })
assert.equal(scored.byKind.emptyRecall, 2)
assert.equal(scored.byKind.misrank, 2)
// 污染：Q1 与 Q7 命中禁用词。查询数分母 8，结果条数分母 9（Q1 三行 + Q2 三行 + Q4/Q5/Q7 各一行）
assert.equal(scored.counts.totalHits, 9)
assert.equal(scored.counts.staleQueries, 2)
assert.deepEqual(scored.metrics.staleQueryRate, { value: 2 / 8, numerator: 2, denominator: 8 })
assert.equal(scored.counts.staleResultRows, 3, '一条结果里多个禁用词只算一条结果')
assert.deepEqual(scored.metrics.staleHitShare, { value: 3 / 9, numerator: 3, denominator: 9 })
assert.deepEqual(scored.metrics.noAnswerFpRate, { value: 1 / 2, numerator: 1, denominator: 2 })
// 失败条目允许一条查询同时算污染和排错/空召回：2 空召回 + 2 排错 + 2 污染 + 1 误召
assert.equal(scored.failureEntries, 7)

// --- 空串 expect 会让 includes('') 每条都命中：必须拒收 ---
assert.throws(() => assertCases([{ q: 'x', expect: '', forbid: [] }]), /expect/)
assert.throws(() => assertCases([{ q: 'x', forbid: [] }]), /expect/)
assert.throws(() => assertCases([{ q: 'x', expect: 'y', forbid: [''] }]), /forbid/)
assert.throws(() => assertCases([{ q: '', expect: 'y' }]), /q/)
assert.throws(() => assertCases([{ q: 'x', expect: null, forbid: 'nope' }]), /forbid/)
assert.doesNotThrow(() => assertCases([{ q: 'x', expect: null, forbid: [] }]))
assert.doesNotThrow(() => assertCases(cases))

// --- 标签体检 ---
const audit = auditCases(
  [
    { q: '重复的', expect: '生产机', forbid: ['测试机 10.0.0.5'], scene: 'a' },
    { q: '重复的', expect: '生产机', forbid: ['语料里没有的禁用词'], scene: 'a' },
  ],
  corpus,
)
assert.ok(audit.counts['duplicate-query'] === 1)
assert.ok(audit.counts['dead-forbid'] === 1)
assert.equal(audit.counts['unreachable-expect'], undefined)

// --- 指纹：改标签会变，改格式不会变 ---
const base = [{ q: 'a', expect: 'b', forbid: [] }]
assert.equal(digestCases(base), digestCases([{ forbid: [], expect: 'b', q: 'a' }]))
assert.notEqual(digestCases(base), digestCases([{ q: 'a', expect: 'c', forbid: [] }]))
assert.notEqual(digestCases(base), digestCases([{ q: 'a', expect: 'b', forbid: ['x'] }]))
assert.notEqual(digestCases(base), digestCases([]))

// --- 冻结集指纹必须和清单一致；CRLF 不算改动 ---
const measured = digestFrozenDir(fixtures)
assert.equal(measured.samples, FROZEN_MANIFEST.samples)
assert.equal(measured.answerable, FROZEN_MANIFEST.answerable)
assert.equal(measured.unanswerable, FROZEN_MANIFEST.unanswerable)
assert.equal(measured.digest, FROZEN_MANIFEST.digest)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-'))
const crlfDir = path.join(tmp, 'crlf')
fs.mkdirSync(crlfDir)
for (const f of fs.readdirSync(fixtures)) {
  const src = path.join(fixtures, f)
  if (!fs.statSync(src).isFile()) continue
  let text = fs.readFileSync(src, 'utf8')
  if (f.endsWith('.md')) text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  fs.writeFileSync(path.join(crlfDir, f), text, 'utf8')
}
assert.equal(digestFrozenDir(crlfDir).digest, FROZEN_MANIFEST.digest, 'CRLF 不该改变指纹')

// --- 删样本 / 改阈值必须被发现 ---
const dropOne = path.join(tmp, 'drop')
fs.mkdirSync(dropOne)
for (const f of fs.readdirSync(fixtures)) {
  const src = path.join(fixtures, f)
  if (!fs.statSync(src).isFile()) continue
  if (/^frozen-.*\.json$/.test(f)) {
    const list = JSON.parse(fs.readFileSync(src, 'utf8'))
    list.pop()
    fs.writeFileSync(path.join(dropOne, f), JSON.stringify(list), 'utf8')
  } else {
    fs.copyFileSync(src, path.join(dropOne, f))
  }
}
const dropped = digestFrozenDir(dropOne)
assert.equal(dropped.samples, FROZEN_MANIFEST.samples - 8)
assert.equal(verifyFrozen(dropped, FROZEN_MANIFEST.config).ok, false)
assert.equal(verifyFrozen(measured, { ...FROZEN_MANIFEST.config, minCoverage: 0.15 }).ok, false)
assert.equal(verifyFrozen(measured, FROZEN_MANIFEST.config).ok, true)
fs.rmSync(tmp, { recursive: true, force: true })

// --- 文本输出必须带分母 ---
const lines = formatMetrics(scored.metrics)
assert.ok(lines.some((l) => l.includes('1 / 6')), 'Recall 行要显示分子/分母')
assert.ok(lines.some((l) => l.includes('2 / 8')), '污染查询率分母是全部查询')
assert.ok(lines.some((l) => l.includes('3 / 9')), '污染结果占比分母是结果条数')
assert.ok(lines.some((l) => l.includes('未命中记 0')), 'MRR 行要说明分子是 1/rank 之和')

console.log('eval-reporter: OK', '| 用例 ' + cases.length + ' 条 | 失败条目 ' + scored.failureEntries + ' | 冻结指纹 ' + measured.digest.slice(0, 12) + '…')