/**
 * dsh-memory-core 延迟基准。
 *
 * 与旧版的关键区别：
 *  1. 必须显式 --mode=real|synthetic，不再由 searchableEntryCount === 0 静默改成合成语料；
 *  2. real 模式下必需源缺失/为空/不可读，或真实语料没有任何可检索条目 → 非零退出（3）；
 *  3. synthetic 模式的标题和页脚都写明「这不是生产语料成绩」，且完全不读真实工作区；
 *  4. 报告 mean + P50/P95/P99 + min/max，不再只看平均值；
 *  5. 固定 seed，同输入两次运行的语料指纹、查询顺序、样本数与门禁结论一致。
 *
 * 退出码：0 通过 / 2 参数错误 / 3 输入源门禁失败 / 4 质量或延迟门禁失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { recall, invalidateMemoryCache } from '../index.js'
import { invalidateCaptureCache } from '../autocapture.mjs'
import { DEFAULT_MEMORY_ROOT, DEFAULT_DIALOGUE_FILE } from '../config.mjs'
import {
  EXIT,
  DEFAULT_PROBES,
  COLD_ROUNDS,
  HOT_ROUNDS,
  TARGET_BUDGET_MS,
  HOT_BUDGET_MS,
  RECALL_CFG,
  parseArgs,
  buildUsage,
  UsageError,
  auditSources,
  gateRealInputs,
  buildSyntheticCorpus,
  seededOrder,
  summarize,
  workloadDigest,
} from './lib/bench-utils.mjs'

const NEGATIVE_QUERY = '量子力学与超弦理论在黑洞视界的辐射实验'

class QualityGateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QualityGateError'
  }
}

function fmt(ms) {
  return Number.isFinite(ms) ? ms.toFixed(3) : String(ms)
}

function kb(bytes) {
  return (Number(bytes || 0) / 1024).toFixed(2) + ' KB'
}

function printHeader(mode, seed, digest) {
  console.log('================================================================')
  if (mode === 'synthetic') {
    console.log(' 合成语料延迟基准报告 —— 这不是生产语料成绩')
  } else {
    console.log(' 真实工作区延迟基准报告 —— 生产语料模式')
  }
  console.log('================================================================')
  if (mode === 'synthetic') {
    console.log('警告: 这不是生产语料成绩。合成语料只用于脚本自检和相对比较，')
    console.log('      不代表真实工作区的召回质量或延迟，不能当生产数据使用。')
    console.log('模式: synthetic（脚本内合成语料；未读取真实工作区）')
  } else {
    console.log('模式: real（本地真实工作区文件；本次没有生成任何合成语料）')
  }
  console.log('种子: ' + seed)
  console.log('可复现指纹: sha256:' + digest)
  console.log('Node: ' + process.version + ' (' + process.platform + ' ' + process.arch + ')')
  console.log('------------------------------------------------------------')
}

function printAudit(rows, totals) {
  console.log('输入源清单（REQUIRED = 必需；real 模式下必需源必须 PRESENT）:')
  for (const row of rows) {
    const requiredTag = row.required ? ' [REQUIRED]' : ''
    const counts = row.searchable
      ? row.entries + ' 条可检索'
      : row.statusEntries + ' 条状态记录'
    const err = row.error ? ' | ERROR: ' + row.error : ''
    console.log(
      '  [' + row.status.toUpperCase() + '] ' + row.label + ' (' + row.id + ')' + requiredTag +
      ': ' + row.bytes + ' B / ' + counts + err,
    )
  }
  console.log(
    '可检索条目总计: ' + totals.searchableEntryCount + ' 条（状态元数据 ' +
    totals.statusRecordCount + ' 条）| 可检索体量 ' + kb(totals.searchableBytes) +
    ' | 单条最大 ' + kb(totals.maxEntryBytes),
  )
}

function assertProbeHit(probe, hits, phase) {
  if (!Array.isArray(hits) || hits.length === 0) {
    throw new QualityGateError(phase + '查询「' + probe.q + '」返回 0 条结果')
  }
  const top = hits[0]
  if (!top || !top.entry || typeof top.entry.text !== 'string') {
    throw new QualityGateError(phase + '查询「' + probe.q + '」Top-1 结构非法')
  }
  if (!Number.isFinite(top.score) || top.score <= 0) {
    throw new QualityGateError(phase + '查询「' + probe.q + '」Top-1 得分非法: ' + top.score)
  }
  if (!top.entry.text.includes(probe.expectedKeyword)) {
    throw new QualityGateError(
      phase + '查询「' + probe.q + '」Top-1 未命中预期关键词「' + probe.expectedKeyword + '」',
    )
  }
}

function runSampling(cfg, probes, seed) {
  const order = seededOrder(seed, probes.length)
  const coldLatencies = []

  for (let i = 0; i < COLD_ROUNDS; i += 1) {
    invalidateMemoryCache()
    if (cfg.autocaptureStore) invalidateCaptureCache(cfg.autocaptureStore)
    const probe = probes[order[i % order.length]]
    const t0 = performance.now()
    const hits = recall(cfg, probe.q, Date.now() + 500)
    const cost = performance.now() - t0
    if (!Number.isFinite(cost) || cost < 0) throw new Error('冷启动采样出现非法耗时: ' + cost)
    coldLatencies.push(cost)
    assertProbeHit(probe, hits, '冷启动')
  }

  // 让缓存进入热态后再采样；预热查询本身不计入统计。
  recall(cfg, '预热基准缓存', Date.now() + 5000)

  const hotLatencies = []
  for (let i = 0; i < HOT_ROUNDS; i += 1) {
    const probe = probes[order[i % order.length]]
    const t0 = performance.now()
    const hits = recall(cfg, probe.q, Date.now() + 150)
    const cost = performance.now() - t0
    if (!Number.isFinite(cost) || cost < 0) throw new Error('热查询采样出现非法耗时: ' + cost)
    hotLatencies.push(cost)
    assertProbeHit(probe, hits, '热查询')
  }

  const negativeHits = recall(cfg, NEGATIVE_QUERY, Date.now() + 150)
  if (negativeHits.length > 0) {
    throw new QualityGateError(
      '负样本安全门禁失败: 无关查询「' + NEGATIVE_QUERY + '」误召 ' + negativeHits.length + ' 条',
    )
  }

  return { order, coldLatencies, hotLatencies }
}

function printStats(label, stats) {
  console.log(label + '（n=' + stats.n + '）:')
  console.log(
    '  mean ' + fmt(stats.mean) + ' ms | P50 ' + fmt(stats.p50) + ' ms | P95 ' +
    fmt(stats.p95) + ' ms | P99 ' + fmt(stats.p99) + ' ms | min ' + fmt(stats.min) +
    ' ms | max ' + fmt(stats.max) + ' ms',
  )
}

function printResults(mode, sampling) {
  const coldStats = summarize(sampling.coldLatencies)
  const hotStats = summarize(sampling.hotLatencies)
  const coldGate = coldStats.p95 <= TARGET_BUDGET_MS
  const hotGate = hotStats.p95 <= HOT_BUDGET_MS

  console.log('------------------------------------------------------------')
  printStats('冷启动 / 磁盘全量重读与索引重建（每次显式清缓存）', coldStats)
  console.log('------------------------------------------------------------')
  printStats('热查询 / 命中内存缓存', hotStats)
  console.log('------------------------------------------------------------')

  const all = [...sampling.coldLatencies, ...sampling.hotLatencies]
  const passCount = all.filter((t) => t <= TARGET_BUDGET_MS).length
  const passRate = ((passCount / all.length) * 100).toFixed(1)

  console.log(
    '质量门禁: 冷 ' + sampling.coldLatencies.length + ' 次 + 热 ' + sampling.hotLatencies.length +
    ' 次 Top-1 检查全部命中预期关键词 | 负例「' + NEGATIVE_QUERY + '」误召 0 条',
  )
  console.log(
    '延迟门禁: 冷 P95 ' + fmt(coldStats.p95) + ' ms ' + (coldGate ? '<=' : '>') + ' ' +
    TARGET_BUDGET_MS + ' ms | 热 P95 ' + fmt(hotStats.p95) + ' ms ' +
    (hotGate ? '<=' : '>') + ' ' + HOT_BUDGET_MS + ' ms',
  )
  console.log('150ms 预算达标率: ' + passRate + '% (' + passCount + '/' + all.length + ')')
  console.log('查询顺序: ' + sampling.order.map((i) => i + 1).join('→'))
  console.log(
    '可复现性: 同输入 + 同 seed 时，可复现指纹、条目数、查询顺序、样本数与门禁结论一致；' +
    '毫秒值受 OS 调度影响，不承诺逐位相同。',
  )
  if (mode === 'synthetic') {
    console.log('再次强调: 这不是生产语料成绩，不能对外当作生产数据。')
  }

  if (!coldGate || !hotGate) {
    console.error(
      '基准未通过: 冷启动 P95 ' + fmt(coldStats.p95) + ' ms（预算 ' + TARGET_BUDGET_MS +
      ' ms），热查询 P95 ' + fmt(hotStats.p95) + ' ms（阈值 ' + HOT_BUDGET_MS + ' ms）',
    )
    console.log('结果: FAIL')
    return EXIT.PERF_GATE
  }

  console.log('结果: PASS')
  return EXIT.OK
}

function buildRealSources() {
  const memoryRoot = process.env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
  const dialogueFile = process.env.DSH_MEMORY_DIALOGUE || DEFAULT_DIALOGUE_FILE
  const structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const autocaptureStore = path.join(dshHome, 'autocapture', 'captures.jsonl')
  const summaryStore = path.join(dshHome, 'autocapture', 'summaries.jsonl')

  const sources = [
    {
      id: 'dialogueFile',
      label: '对话记录文件',
      path: dialogueFile,
      required: true,
      searchable: true,
      kind: 'file',
      format: 'markdown',
    },
    {
      id: 'memoryRoot',
      label: '记忆档案目录',
      path: memoryRoot,
      required: false,
      searchable: true,
      kind: 'dir',
      format: 'markdown',
      // 只审计 recall 真正读取的三个文件；目录里其他 md（开场/身份等）不进索引。
      include: ['日记.md', '生长/状态.md', '生长/生长记录.md'],
    },
    {
      id: 'structuredFile',
      label: '结构化状态表',
      path: structuredFile,
      required: false,
      searchable: false,
      kind: 'file',
      format: 'jsonl',
      recordKind: 'status',
    },
    {
      id: 'autocaptureStore',
      label: '自动捕获存储',
      path: autocaptureStore,
      required: false,
      searchable: true,
      kind: 'file',
      format: 'jsonl',
      recordKind: 'captures',
    },
    {
      id: 'summaryStore',
      label: '后台摘要存储',
      path: summaryStore,
      required: false,
      searchable: true,
      kind: 'file',
      format: 'jsonl',
      recordKind: 'summaries',
    },
  ]

  const cfg = {
    ...RECALL_CFG,
    memoryRoot,
    dialogueFile,
    structuredFile,
    autocaptureStore,
    summaryStore,
  }
  return { sources, cfg }
}

function runReal(opts) {
  const { sources, cfg } = buildRealSources()
  const audit = auditSources(sources)
  const digest = workloadDigest({
    mode: 'real',
    seed: opts.seed,
    probes: DEFAULT_PROBES,
    rows: audit.rows,
  })

  printHeader('real', opts.seed, digest)
  printAudit(audit.rows, audit)

  const errors = gateRealInputs(audit.rows, audit)
  if (errors.length > 0) {
    console.error('')
    console.error('输入源门禁失败（real 模式不会回退到合成语料）:')
    for (const error of errors) console.error('  ✗ ' + error)
    console.error('修正路径/内容后重跑 --mode=real；若确实要测合成语料，请显式加 --mode=synthetic。')
    return EXIT.INPUT_GATE
  }

  let sampling
  try {
    sampling = runSampling(cfg, DEFAULT_PROBES, opts.seed)
  } catch (err) {
    if (err instanceof QualityGateError) {
      console.error('')
      console.error('质量门禁失败: ' + err.message)
      return EXIT.PERF_GATE
    }
    throw err
  }
  return printResults('real', sampling)
}

function runSynthetic(opts) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-bench-'))
  try {
    const built = buildSyntheticCorpus({ rootDir: tempDir, seed: opts.seed })
    const digest = workloadDigest({
      mode: 'synthetic',
      seed: opts.seed,
      probes: DEFAULT_PROBES,
      rows: built.rows,
    })

    printHeader('synthetic', opts.seed, digest)
    printAudit(built.rows, built.totals)

    const cfg = { ...RECALL_CFG, ...built.files }
    let sampling
    try {
      sampling = runSampling(cfg, DEFAULT_PROBES, opts.seed)
    } catch (err) {
      if (err instanceof QualityGateError) {
        console.error('')
        console.error('质量门禁失败: ' + err.message)
        return EXIT.PERF_GATE
      }
      throw err
    }
    return printResults('synthetic', sampling)
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      console.error('参数错误: ' + err.message)
      console.error('')
      console.error(buildUsage())
      return EXIT.USAGE
    }
    throw err
  }

  if (opts.help) {
    console.log(buildUsage())
    return EXIT.OK
  }
  if (!opts.mode) {
    console.error('参数错误: 必须显式指定 --mode=real 或 --mode=synthetic（脚本不会猜测语料来源）')
    console.error('')
    console.error(buildUsage())
    return EXIT.USAGE
  }
  if (opts.mode === 'real') return runReal(opts)
  return runSynthetic(opts)
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error('基准脚本异常退出: ' + (err && err.stack ? err.stack : String(err)))
  process.exitCode = 1
}