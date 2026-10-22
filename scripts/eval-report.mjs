import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 评测公共件：口径、打分、完整性校验、JSON 报告。
 *
 * 存在的理由：scripts/quality-eval.mjs（开发集）和 scripts/quality-frozen.mjs（冻结集）
 * 各写了一份打分循环，指标同名不同分母，文档里又出现了第三种叫法。
 * 这里只允许一份实现，两边都调它——口径统一靠共享代码，不靠自觉。
 *
 * 本文件不含任何阈值决策：cfg 由调用方传入，这里只负责如实统计。
 */

export const SCHEMA = 'dsh-memory-core/quality-report@1'

/**
 * 指标定义（唯一口径）。text / JSON 都由这张表生成，改分母必须改这里。
 * num/den 用自然语言写清，避免以后又出现同名不同分母。
 */
export const METRIC_DEFS = {
  recallAt1: {
    label: 'Recall@1',
    num: '有答案查询中，expect 出现在第 1 条的查询数',
    den: '有答案查询数',
    unit: 'query',
  },
  recallAt3: {
    label: 'Recall@3',
    num: '有答案查询中，expect 出现在前 3 条的查询数',
    den: '有答案查询数',
    unit: 'query',
  },
  mrr: {
    label: 'MRR',
    num: '有答案查询逐条 1/rank 之和（未命中记 0）',
    den: '有答案查询数',
    unit: 'query',
  },
  emptyRecallRate: {
    label: '空召回率',
    num: '有答案查询中，一条都没返回的查询数',
    den: '有答案查询数',
    unit: 'query',
  },
  staleQueryRate: {
    label: '污染查询率',
    num: '返回结果里出现 forbid 明令禁止内容的查询数',
    den: '全部查询数（含无答案查询）',
    unit: 'query',
  },
  staleHitShare: {
    label: '污染结果占比',
    num: '命中 forbid 内容的返回结果条数（一条结果含多个禁用词只算 1）',
    den: '全部返回结果条数（所有查询 hit 之和）',
    unit: 'result',
  },
  noAnswerFpRate: {
    label: '无答案误召率',
    num: '无答案查询中，返回了至少 1 条的查询数',
    den: '无答案查询数（expect 为 null）',
    unit: 'query',
  },
}

export const FAILURE_KINDS = {
  emptyRecall: '空召回：有答案但返回 0 条',
  misrank: '有结果但排序错：正确条目不在 top-K',
  stale: '污染：返回了 forbid 明令禁止的内容',
  noAnswer: '无答案误召：语料里没答案却给了结果',
}

const round = (n, d) => (d === 0 ? null : n / d)
const rate = (n, d) => ({ value: round(n, d), numerator: n, denominator: d })

const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(1) + '%')

/** 严格按契约校验用例形状。形状不对直接抛，不许悄悄算成 MISS。 */
export function assertCases(cases) {
  const problems = []
  cases.forEach((c, i) => {
    const at = '#' + i + (c && c.q ? ' (' + c.q + ')' : '')
    if (!c || typeof c.q !== 'string' || c.q.trim() === '') problems.push(at + ' 缺少字符串 q')
    if (!c || !('expect' in c)) problems.push(at + ' 缺少 expect 字段（无答案请显式写 null）')
    else if (c.expect !== null && (typeof c.expect !== 'string' || c.expect === '')) {
      // 空串 expect 会被 String.includes('') 判成「每条都命中」，是实测可用的作弊口子。
      problems.push(at + ' expect 必须是非空字符串或 null（空串会让每条结果都算命中）')
    }
    if (c && c.forbid !== undefined && !Array.isArray(c.forbid)) problems.push(at + ' forbid 必须是数组')
    if (Array.isArray(c && c.forbid) && c.forbid.some((f) => typeof f !== 'string' || f === '')) {
      problems.push(at + ' forbid 里只能放非空字符串')
    }
  })
  if (problems.length) {
    throw new Error('评测用例形状不合法：\n  ' + problems.join('\n  '))
  }
}

/**
 * 唯一一份打分实现。
 * @param {{cases:object[], recallFn:(q:string)=>object[], topK?:number}} opts
 */
export function scoreCases({ cases, recallFn, topK = 3 }) {
  assertCases(cases)
  let hit1 = 0
  let hit3 = 0
  let mrrSum = 0
  let answerable = 0
  let unanswerable = 0
  let totalHits = 0
  let emptyRecalls = 0
  let staleQueries = 0
  let staleResultRows = 0
  let staleTermHits = 0
  let noAnswerFp = 0
  const failures = []
  const byKind = { emptyRecall: 0, misrank: 0, stale: 0, noAnswer: 0 }
  const sceneMap = new Map()

  for (const c of cases) {
    const scene = c.scene || 'default'
    if (!sceneMap.has(scene)) {
      sceneMap.set(scene, {
        scene,
        samples: 0,
        answerable: 0,
        unanswerable: 0,
        emptyRecalls: 0,
        hit1: 0,
        hit3: 0,
        mrrSum: 0,
        staleQueries: 0,
        noAnswerFp: 0,
      })
    }
    const s = sceneMap.get(scene)
    s.samples += 1

    const hits = recallFn(c.q, topK)
    const texts = hits.map((h) => h.entry.text)
    totalHits += texts.length

    // 污染：返回了 forbid 里的内容。按结果条数、禁用词数分别记，两种都进 JSON。
    const forbid = c.forbid || []
    const hitTerms = forbid.filter((f) => texts.some((t) => t.includes(f)))
    const rowIdx = new Set()
    for (const f of forbid) {
      texts.forEach((t, i) => {
        if (t.includes(f)) rowIdx.add(i)
      })
    }
    if (hitTerms.length) {
      staleQueries += 1
      staleResultRows += rowIdx.size
      staleTermHits += hitTerms.length
      s.staleQueries += 1
      byKind.stale += 1
      failures.push({
        kind: 'stale',
        scene,
        query: c.q,
        expected: null,
        detail: '不该出现: ' + hitTerms.join(', '),
        got: texts.map((t) => t.slice(0, 14)),
      })
    }

    if (c.expect === null) {
      unanswerable += 1
      s.unanswerable += 1
      if (texts.length > 0) {
        noAnswerFp += 1
        s.noAnswerFp += 1
        byKind.noAnswer += 1
        failures.push({
          kind: 'noAnswer',
          scene,
          query: c.q,
          expected: null,
          detail: '本该空召回，实际 ' + texts.length + ' 条',
          got: texts.map((t) => t.slice(0, 14)),
        })
      }
      continue
    }

    answerable += 1
    s.answerable += 1
    const rank = texts.findIndex((t) => t.includes(c.expect))
    if (rank === 0) {
      hit1 += 1
      s.hit1 += 1
    }
    if (rank >= 0 && rank < topK) {
      hit3 += 1
      s.hit3 += 1
    }
    if (rank >= 0) {
      mrrSum += 1 / (rank + 1)
      s.mrrSum += 1 / (rank + 1)
    }
    if (texts.length === 0) {
      // 空召回单独计数：它原来混在 MISS 里，导致「召不回来」和「排错了」分不清。
      emptyRecalls += 1
      s.emptyRecalls += 1
      byKind.emptyRecall += 1
      failures.push({
        kind: 'emptyRecall',
        scene,
        query: c.q,
        expected: c.expect,
        detail: '返回 0 条',
        got: [],
      })
    } else if (rank < 0) {
      byKind.misrank += 1
      failures.push({
        kind: 'misrank',
        scene,
        query: c.q,
        expected: c.expect,
        detail: '期望条目不在 top-' + topK,
        got: texts.map((t) => t.slice(0, 14)),
      })
    }
  }

  const metrics = {
    recallAt1: rate(hit1, answerable),
    recallAt3: rate(hit3, answerable),
    mrr: rate(mrrSum, answerable),
    emptyRecallRate: rate(emptyRecalls, answerable),
    staleQueryRate: rate(staleQueries, cases.length),
    staleHitShare: rate(staleResultRows, totalHits),
    noAnswerFpRate: rate(noAnswerFp, unanswerable),
  }

  const scenes = [...sceneMap.values()]
    .sort((a, b) => (a.scene < b.scene ? -1 : a.scene > b.scene ? 1 : 0))
    .map((s) => ({
      ...s,
      recallAt1: rate(s.hit1, s.answerable),
      recallAt3: rate(s.hit3, s.answerable),
      mrr: rate(s.mrrSum, s.answerable),
      emptyRecallRate: rate(s.emptyRecalls, s.answerable),
    }))

  return {
    counts: {
      samples: cases.length,
      answerable,
      unanswerable,
      totalHits,
      emptyRecalls,
      staleQueries,
      staleResultRows,
      staleTermHits,
      noAnswerFp,
    },
    metrics,
    scenes,
    failures,
    byKind,
    failureEntries: failures.length,
  }
}

/** 标签体检：只看能不能「改标签变好」，不改任何标签。 */
export function auditCases(cases, corpusText = null) {
  const issues = []
  const seen = new Map()
  const shortLimit = 4
  for (const c of cases) {
    const scene = c.scene || 'default'
    if (seen.has(c.q)) {
      issues.push({ code: 'duplicate-query', scene, query: c.q, detail: '查询重复，权重被放大' })
    }
    seen.set(c.q, true)
    if (c.expect === null) continue
    if (typeof c.expect !== 'string') continue
    if (c.expect.length <= shortLimit) {
      issues.push({
        code: 'short-expect',
        scene,
        query: c.q,
        detail: 'expect 只有 ' + c.expect.length + ' 字（「' + c.expect + '」），越短越容易碰巧命中',
      })
    }
    if ((c.forbid || []).some((f) => c.expect.includes(f))) {
      issues.push({ code: 'expect-in-forbid', scene, query: c.q, detail: 'expect 与 forbid 互相包含' })
    }
    if (corpusText !== null) {
      for (const f of c.forbid || []) {
        if (!corpusText.includes(f)) {
          issues.push({
            code: 'dead-forbid',
            scene,
            query: c.q,
            detail: 'forbid「' + f + '」在语料里不存在，永远不会触发',
          })
        }
      }
      if (!corpusText.includes(c.expect)) {
        issues.push({
          code: 'unreachable-expect',
          scene,
          query: c.q,
          detail: 'expect「' + c.expect + '」不在语料里，这条永远不可能命中',
        })
      }
    }
  }
  const counts = {}
  for (const i of issues) counts[i.code] = (counts[i.code] || 0) + 1
  return { issues, counts }
}

const normalizeText = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/gm, '')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

/** 单条用例集的内容指纹：改标签、删样本、换查询都会变，格式化与换行符不会。 */
export function digestCases(cases) {
  return sha256(canonicalJson(cases))
}

/**
 * 冻结集数据指纹。
 * 用解析后的规范 JSON 做指纹，不用原始字节：Git 在 Windows 上会 checkout 成 CRLF，
 * 字节哈希会让同一份标签在不同机器上算出不同结果。
 */
export function digestFrozenDir(fixturesDir) {
  const files = fs
    .readdirSync(fixturesDir)
    .filter((f) => /^frozen-.*\.json$/.test(f))
    .sort()
  const perFile = []
  let answerable = 0
  let unanswerable = 0
  let total = 0
  for (const file of files) {
    const raw = fs.readFileSync(path.join(fixturesDir, file), 'utf8')
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) throw new Error(file + ' 应该是数组')
    const cases = list.map((c) => ({ ...c, scene: file.replace(/^frozen-/, '').replace(/\.json$/, '') }))
    const ans = cases.filter((c) => c.expect !== null).length
    answerable += ans
    unanswerable += cases.length - ans
    total += cases.length
    perFile.push({
      file,
      samples: cases.length,
      answerable: ans,
      unanswerable: cases.length - ans,
      labelsDigest: digestCases(cases),
    })
  }
  const corpusPath = path.join(fixturesDir, 'frozen-corpus.md')
  const corpusRaw = fs.readFileSync(corpusPath, 'utf8')
  const corpusDigest = sha256(normalizeText(corpusRaw))
  const digest = sha256(
    canonicalJson({
      files: perFile.map((f) => [f.file, f.samples, f.labelsDigest]),
      corpus: corpusDigest,
    }),
  )
  return {
    digest,
    corpusDigest,
    corpusBytes: Buffer.byteLength(corpusRaw, 'utf8'),
    samples: total,
    answerable,
    unanswerable,
    files: perFile,
  }
}

/**
 * 冻结集基线清单。改冻结集必须走 --rebaseline 显式重记，不能顺手把数字改到绿。
 * 记的是「数据 + 阈值」，任一漂移都算基线作废。
 */
export const FROZEN_MANIFEST = {
  digest: '553da9431361104247284258fde2ec08441d49226f0a4a0fecb72c27cab8be70',
  samples: 157,
  answerable: 133,
  unanswerable: 24,
  corpusDigest: 'c0a76ce1e6bd0ed222b6d91a8b8832bf31dd7a06a7bd6774e5414b1401920744',
  config: { topK: 3, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30 },
}

export function verifyFrozen(actual, config) {
  const mismatches = []
  const m = FROZEN_MANIFEST
  if (m.digest !== actual.digest) mismatches.push('冻结集内容指纹不一致（标签或语料被改动）')
  if (m.samples !== actual.samples) mismatches.push('样本数不一致: 清单 ' + m.samples + ' / 实际 ' + actual.samples)
  if (m.answerable !== actual.answerable) {
    mismatches.push('有答案条数不一致: 清单 ' + m.answerable + ' / 实际 ' + actual.answerable)
  }
  if (m.corpusDigest !== actual.corpusDigest) mismatches.push('语料指纹不一致')
  for (const k of Object.keys(m.config)) {
    if (m.config[k] !== config[k]) mismatches.push('阈值 ' + k + ' 被改动: 清单 ' + m.config[k] + ' / 实际 ' + config[k])
  }
  return { ok: mismatches.length === 0, mismatches }
}

export function gitMeta(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const commit = run(['rev-parse', 'HEAD']) || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || null
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const porcelain = run(['status', '--porcelain'])
  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch,
    dirty: porcelain === null ? null : porcelain.length > 0,
    dirtyFiles: porcelain === null ? null : porcelain.split('\n').filter(Boolean).length,
  }
}

export function parseJsonTarget(argv, toolName) {
  const flag = argv.find((a) => a === '--json' || a.startsWith('--json='))
  const envPath = process.env.DSH_QUALITY_JSON
  const next = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null
  const explicit = next && !next.startsWith('--') ? next : null
  const inline = argv.find((a) => a.startsWith('--json='))?.slice('--json='.length)
  const wanted = flag ? inline || explicit || null : envPath || null
  if (wanted === '-') return { mode: 'stdout', path: null }
  if (wanted) return { mode: 'file', path: path.resolve(wanted) }
  return {
    mode: 'file',
    path: path.join(os.tmpdir(), 'dsh-memory-quality', path.basename(toolName).replace(/\.mjs$/, '') + '.json'),
  }
}

export function emitReport(report, target) {
  const json = JSON.stringify(report, null, 2)
  if (target.mode === 'stdout') {
    console.log(json)
    return null
  }
  fs.mkdirSync(path.dirname(target.path), { recursive: true })
  fs.writeFileSync(target.path, json + '\n', 'utf8')
  return target.path
}

// 中文在终端里占两列，padEnd 按字符数算会错位
const displayWidth = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const padDisplay = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)))

/** 文本报告：指标行由 METRIC_DEFS 生成，带分子/分母，不让读者猜。 */
export function formatMetrics(metrics) {
  const lines = []
  for (const [key, def] of Object.entries(METRIC_DEFS)) {
    const v = metrics[key]
    if (!v) continue
    const value = key === 'mrr' ? (v.value === null ? 'n/a' : v.value.toFixed(3)) : pct(v.value)
    // MRR 的分子是 1/rank 之和，不是条数，别写成 "65 / 133"
    const frac = key === 'mrr' ? v.numerator.toFixed(2) + ' 分 / ' + v.denominator : v.numerator + ' / ' + v.denominator
    const den = key === 'mrr' ? def.den + '（每条 1/rank，未命中记 0）' : def.den
    lines.push(padDisplay(def.label, 14) + ': ' + value.padStart(6) + '   = ' + frac.padEnd(14) + '  ' + den)
  }
  return lines
}

export function formatSceneTable(scenes) {
  const lines = []
  for (const s of scenes) {
    lines.push(
      s.scene.padEnd(16) +
        ' n=' +
        String(s.samples).padStart(3) +
        ' ans=' +
        String(s.answerable).padStart(3) +
        ' R@1=' +
        pct(s.recallAt1.value).padStart(6) +
        ' R@3=' +
        pct(s.recallAt3.value).padStart(6) +
        ' MRR=' +
        (s.mrr.value === null ? 'n/a' : s.mrr.value.toFixed(3)) +
        ' 空召回=' +
        String(s.emptyRecalls).padStart(2) +
        ' 污染=' +
        String(s.staleQueries).padStart(2) +
        ' 误召=' +
        String(s.noAnswerFp).padStart(2),
    )
  }
  return lines
}

export function buildReport({ tool, kind, datasetId, datasetPath = null, cases, config, scored, integrity, warnings = [] }) {
  const scenes = scored.scenes.map((s) => ({
    scene: s.scene,
    samples: s.samples,
    answerable: s.answerable,
    unanswerable: s.unanswerable,
    recallAt1: s.recallAt1,
    recallAt3: s.recallAt3,
    mrr: s.mrr,
    emptyRecallRate: s.emptyRecallRate,
    emptyRecalls: s.emptyRecalls,
    staleQueries: s.staleQueries,
    noAnswerFp: s.noAnswerFp,
  }))
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    tool,
    dataset: {
      id: datasetId,
      kind, // dev | frozen
      path: datasetPath,
      sampleCount: scored.counts.samples,
      answerable: scored.counts.answerable,
      unanswerable: scored.counts.unanswerable,
      scenes,
    },
    config,
    metrics: scored.metrics,
    metricDefinitions: METRIC_DEFS,
    counts: scored.counts,
    failures: {
      entries: scored.failureEntries,
      byKind: scored.byKind,
      kinds: FAILURE_KINDS,
      items: scored.failures,
    },
    integrity,
    warnings,
  }
}

/** 给人看的收尾：一条 JSON 路径行，CI 直接 grep。 */
export function printReportTail(reportPath, report) {
  if (reportPath) console.log('\nJSON 报告: ' + reportPath)
  console.log(
    'JSON 摘要: ' +
      JSON.stringify({
        commit: report.git.commitShort,
        dataset: report.dataset.id,
        samples: report.dataset.sampleCount,
        metrics: Object.fromEntries(
          Object.entries(report.metrics).map(([k, v]) => [k, v.value === null ? null : Number(v.value.toFixed(4))]),
        ),
        integrity: report.integrity.ok,
      }),
  )
}
