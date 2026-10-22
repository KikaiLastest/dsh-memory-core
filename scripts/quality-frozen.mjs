import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'
import {
  METRIC_DEFS,
  FAILURE_KINDS,
  FROZEN_MANIFEST,
  auditCases,
  buildReport,
  digestCases,
  digestFrozenDir,
  emitReport,
  formatMetrics,
  formatSceneTable,
  gitMeta,
  parseJsonTarget,
  printReportTail,
  scoreCases,
  verifyFrozen,
} from './eval-report.mjs'

/**
 * 冻结集评测。
 *
 * 和 scripts/quality-eval.mjs 的区别，不是「语料更大」而是「不参与调参」：
 * - quality-eval.mjs 的样本是边写边改出来的，用来看改动有没有把已知场景弄坏；
 * - 这里的语料和查询都冻在 test/fixtures 里，写完就不再为了通过去改它。
 *   语料变了等于换了考卷，基线必须重测。
 *
 * 所以这个脚本只报数字，不设门禁、不许用它的结果去调权重。
 *
 * 指标口径、打分、JSON 报告都在 scripts/eval-report.mjs，和开发集共用一份实现，
 * 避免同名指标两边分母不同。这里只负责跑、看、报。
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
const corpusText = fs.readFileSync(corpusFile, 'utf8')
for (const file of caseFiles) {
  const raw = fs.readFileSync(path.join(fixtures, file), 'utf8')
  let list
  try {
    list = JSON.parse(raw)
  } catch (e) {
    console.error(file + ' 不是合法 JSON：' + e.message)
    process.exit(2)
  }
  if (!Array.isArray(list)) {
    console.error(file + ' 应该是数组')
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

const scored = scoreCases({
  cases,
  recallFn: (q, topK) => recall({ ...cfg, topK }, q, Date.now() + 5000),
  topK: cfg.topK,
})

// 完整性：冻结集内容 + 阈值 + 评测侧的 prep 常量，任一漂移都说明基线和这次的数字不同卷。
const measured = digestFrozenDir(fixtures)
const harness = { superseded: [...SUPERSEDED].sort(), junkFacts: [...JUNK_FACTS].sort() }
const integrityCheck = verifyFrozen(measured, cfg, harness)
const labelAudit = auditCases(cases, corpusText)
const gm = gitMeta(root)
const jsonTarget = parseJsonTarget(process.argv.slice(2), 'quality-frozen.mjs')

const warnings = []
if (gm.dirty) warnings.push('工作区有未提交改动 (' + gm.dirtyFiles + ' 个文件)，这次数字对应的不是干净的 commit')
if (labelAudit.counts['short-expect']) {
  warnings.push('标签体检: ' + labelAudit.counts['short-expect'] + ' 条 expect 只有 ≤4 字，越短越容易碰巧命中')
}
warnings.push(
  '冻结集不设门禁：数字用于观察基线，不作通过条件；改动语料或阈值必须先跑 --rebaseline 并重新记录基线',
)

const report = buildReport({
  tool: 'scripts/quality-frozen.mjs',
  kind: 'frozen',
  datasetId: 'frozen-157',
  datasetPath: path.relative(root, fixtures).replace(/\\/g, '/'),
  cases,
  config: cfg,
  scored,
  integrity: {
    ok: integrityCheck.ok,
    mismatches: integrityCheck.mismatches,
    fixtureDigest: measured.digest,
    expectedFixtureDigest: FROZEN_MANIFEST.digest,
    corpusDigest: measured.corpusDigest,
    labelsDigest: digestCases(cases.map(({ scene, q, expect, forbid }) => ({ scene, q, expect, forbid }))),
    samples: measured.samples,
    expectedSamples: FROZEN_MANIFEST.samples,
    answerable: measured.answerable,
    unanswerable: measured.unanswerable,
    files: measured.files,
    harness,
    configExpected: FROZEN_MANIFEST.config,
    labelAudit,
  },
  warnings,
})
report.git = gm

const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(1) + '%')
const fk = scored.byKind
const failEntries = scored.failureEntries

console.log('=== 冻结集基线 ===')
console.log(
  '样本 ' + cases.length + ' 条（有答案 ' + scored.counts.answerable + ' / 无答案 ' + scored.counts.unanswerable + '）' +
    ' | 全部查询共返回 ' + scored.counts.totalHits + ' 条结果',
)
console.log('\n指标（分数 = 分子 / 分母，分母写在这里；实现见 scripts/eval-report.mjs METRIC_DEFS）:')
for (const line of formatMetrics(scored.metrics)) console.log('  ' + line)

console.log('\n--- 口径对照（同一个量在不同文档里的旧叫法）---')
console.log('  受污染查询比例(旧)          = 污染查询率   = ' + scored.counts.staleQueries + '/' + cases.length)
console.log('  过期结果占比(旧)            = 污染结果占比 = ' + scored.counts.staleResultRows + '/' + scored.counts.totalHits)
console.log(
  '  旧口径的「过期结果占比」分子用的是「命中的禁用词数」(' + scored.counts.staleTermHits + ') 而不是结果条数，' +
    '单位不一致，已在本次统一为结果条数；旧算法值 = ' + pct(scored.counts.totalHits ? scored.counts.staleTermHits / scored.counts.totalHits : null),
)
console.log('  过期记忆漏回率(旧, 开发集)  = 污染查询率（同一个量，只是叫法不同）')
console.log(
  '  过期事实泄漏 3/4%(FAILURE-ANALYSIS) = 污染查询数 / 失败条目数 = ' +
    scored.counts.staleQueries + '/' + failEntries +
    ' = ' + pct(failEntries ? scored.counts.staleQueries / failEntries : null),
)

console.log('\n--- 失败构成（' + failEntries + ' 个条目，可多条叠加在同一条查询上）---')
for (const key of Object.keys(FAILURE_KINDS)) {
  console.log(
    '  ' + FAILURE_KINDS[key].padEnd(34) + ' ' + String(fk[key]).padStart(3) + '  ' +
      pct(failEntries ? fk[key] / failEntries : null).padStart(6),
  )
}

console.log('\n--- 分场景 ---')
for (const line of formatSceneTable(scored.scenes)) console.log(line)

if (scored.failures.length) {
  console.log('\n--- 失败明细 ' + scored.failures.length + ' 条 ---')
  for (const f of scored.failures) {
    const head = '  [' + f.kind + '][' + f.scene + '] ' + f.query
    if (f.kind === 'stale') console.log(head + ' -> ' + f.detail)
    else if (f.kind === 'noAnswer') console.log(head + ' -> ' + f.detail)
    else if (f.kind === 'emptyRecall') console.log(head + ' -> 期望「' + f.expected + '」，返回 0 条')
    else console.log(head + ' -> 期望「' + f.expected + '」，实际: ' + (f.got.join(' | ') || '(空)'))
  }
}

console.log('\n--- 完整性 ---')
if (integrityCheck.ok) {
  console.log('  冻结集指纹 OK: ' + measured.digest.slice(0, 16) + '…  样本 ' + measured.samples + '  阈值与清单一致')
} else {
  console.log('  !! 冻结集完整性校验失败，本次数字不能当基线 !!')
  for (const m of integrityCheck.mismatches) console.log('   - ' + m)
  console.log('  如果这是有意的重冻（改语料/改阈值），跑 node scripts/quality-frozen.mjs --rebaseline')
}
if (labelAudit.issues.length) {
  console.log('  标签体检 ' + labelAudit.issues.length + ' 项（不代表指标错，只说明标签本身的宽松度）:')
  for (const i of labelAudit.issues.slice(0, 8)) console.log('   - [' + i.code + '] ' + i.query + ' :: ' + i.detail)
  if (labelAudit.issues.length > 8) console.log('   - …其余 ' + (labelAudit.issues.length - 8) + ' 项见 JSON labelAudit')
}
console.log('  【防作弊面】本脚本没有被改标签/删样本变好的空间：')
console.log('   - 改 expect/forbid/q、删用例、改语料 → 冻结集指纹不匹配（上面会报）')
console.log('   - 改 SUPERSEDED / JUNK_FACTS / 阈值 → 同样不匹配')
console.log('   - expect 写成空串会让 String.includes("") 判每条都命中 → assertCases 直接报错退出')

const jsonPath = emitReport(report, jsonTarget)
printReportTail(jsonPath, report)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

// 冻结集故意不设门禁：它的数字是用来观察的，不是用来通过的门。
// 拿它当门禁，迟早会为了让它绿而去改语料或改权重。
// 但「卷子被改了」不是观察结果，是基线作废：退出码 2，避免被当成绩读。
if (!integrityCheck.ok) {
  if (process.argv.includes('--rebaseline')) {
    console.error('\n新的基线清单（确认是有意重冻后，粘贴到 scripts/eval-report.mjs 的 FROZEN_MANIFEST）:')
    console.error(
      JSON.stringify(
        {
          digest: measured.digest,
          samples: measured.samples,
          answerable: measured.answerable,
          unanswerable: measured.unanswerable,
          corpusDigest: measured.corpusDigest,
          config: FROZEN_MANIFEST.config,
          harness,
        },
        null,
        2,
      ),
    )
  }
  process.exit(2)
}
process.exitCode = 0
