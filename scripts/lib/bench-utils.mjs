/**
 * 基准脚本的纯函数工具层。
 *
 * 放在单独模块里，是为了让 scripts/benchmark-latency.test.mjs 能直接 import 这些
 * 参数解析、分位数、审计与合成语料函数，而不用把整个基准脚本跑一遍。
 * 只依赖 Node 内置模块，保持项目「零运行时依赖」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 退出码：0 通过 / 2 参数错误 / 3 输入源门禁失败 / 4 质量或延迟门禁失败。 */
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, INPUT_GATE: 3, PERF_GATE: 4 })

export const MODES = Object.freeze(['real', 'synthetic'])
export const DEFAULT_SEED = 20261022
export const COLD_ROUNDS = 50
export const HOT_ROUNDS = 200
export const TARGET_BUDGET_MS = 150
export const HOT_BUDGET_MS = 10

/** 真实/合成两种模式共用的召回配置，避免两边参数不同导致数字不可比。 */
export const RECALL_CFG = Object.freeze({
  topK: 8,
  minCoverage: 0.15,
  minMatched: 1,
  minRatio: 0.1,
  halfLifeDays: 30,
})

/**
 * 基准探针。合成语料会把这些查询和关键词原样写进去；
 * real 模式则要求真实工作区里确实存在这些主题，否则质量门禁会明确报失败
 * （不会偷偷换成合成语料）。
 */
export const DEFAULT_PROBES = Object.freeze(
  [
    { q: '本地部署优化方案', expectedKeyword: '优化方案' },
    { q: '炉石盒子崩溃排障', expectedKeyword: '炉石' },
    { q: '逆向工程模拟靶场', expectedKeyword: '靶场' },
    { q: '自动刷B站插件', expectedKeyword: 'B站' },
    { q: '自研记忆核心', expectedKeyword: '记忆' },
  ].map((p) => Object.freeze(p)),
)

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export function buildUsage() {
  return [
    '用法:',
    '  node scripts/benchmark-latency.mjs --mode=real [--seed=20261022]',
    '  node scripts/benchmark-latency.mjs --mode=synthetic [--seed=20261022]',
    '',
    '参数:',
    '  --mode=real      只测本地真实工作区。必需源缺失/为空/不可读或没有可检索条目时',
    '                   非零退出，绝不回退到合成语料。',
    '  --mode=synthetic 测脚本内合成语料，不读取真实工作区；报告会明确写「这不是生产语料成绩」。',
    '  --seed=<uint32>  固定随机种子，默认 20261022。同一输入 + 同一 seed 两次运行，',
    '                   语料指纹、查询顺序、样本数与门禁结论完全一致。',
    '  --help, -h       显示本帮助。',
    '',
    '退出码:',
    '  0 通过 | ' + EXIT.USAGE + ' 参数错误 | ' + EXIT.INPUT_GATE + ' 输入源门禁失败 | ' + EXIT.PERF_GATE + ' 质量/延迟门禁失败',
    '',
    'real 模式读取的路径（环境变量优先）:',
    '  DSH_MEMORY_DIALOGUE / DSH_MEMORY_ROOT / DSH_HOME',
  ].join('\n')
}

/**
 * 严格解析命令行：mode 必须显式给出，未知参数直接报错。
 * 不做「没写 mode 就猜一个」的兜底——那正是旧脚本 P1 问题的根源。
 */
export function parseArgs(argv) {
  const out = { mode: null, seed: DEFAULT_SEED, help: false }
  const seen = new Set()

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (name !== '--mode' && name !== '--seed') throw new UsageError('未知参数: ' + arg)

    let value
    if (inline !== null) {
      value = inline
    } else {
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('--')) {
        throw new UsageError('参数 ' + name + ' 缺少取值')
      }
      value = String(next)
      i += 1
    }
    if (seen.has(name)) throw new UsageError('参数 ' + name + ' 重复出现')
    seen.add(name)
    value = value.trim()
    if (value === '') throw new UsageError('参数 ' + name + ' 的取值不能为空')

    if (name === '--mode') {
      if (!MODES.includes(value)) {
        throw new UsageError('--mode 只能是 real 或 synthetic，收到: ' + value)
      }
      out.mode = value
      continue
    }

    if (!/^\d+$/.test(value)) throw new UsageError('--seed 必须是非负整数，收到: ' + value)
    const seed = Number(value)
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new UsageError('--seed 必须在 0..4294967295 之间，收到: ' + value)
    }
    out.seed = seed
  }
  return out
}

/** deterministic PRNG（mulberry32）：同一 seed 永远给出同一串 [0,1)。 */
export function makeRng(seed) {
  let a = Number(seed) >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按 seed 生成 0..n-1 的固定排列，用来固定探针顺序。 */
export function seededOrder(seed, n) {
  const rng = makeRng(seed)
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** 线性插值分位数（与 numpy / Excel PERCENTILE.INC 同口径），输入会被拷贝后排序。 */
export function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('percentile 需要非空样本')
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error('percentile 的 p 必须在 0..100，收到: ' + p)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const h = (sorted.length - 1) * (p / 100)
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo)
}

/** 均值 + P50/P95/P99 + min/max。基准报告不能只报一个平均值。 */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('summarize 需要非空样本')
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    n: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 与 index.js 的 splitEntries 同口径：>=40 字符、第二行不是表格的 Markdown 小节。 */
export function splitMarkdownEntries(text) {
  const out = []
  for (const part of String(text ?? '').split(/\n(?=#{2,3} )/)) {
    const t = part.trim()
    if (!t) continue
    if (t.length >= 40 && !/^\|/.test(t.split('\n')[1] || '')) out.push(t)
  }
  return out
}

function parseJsonlRecords(kind, lines) {
  const out = []
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    if (kind === 'captures') {
      if (typeof rec.text === 'string' && rec.text.length >= 5) out.push(rec)
    } else if (kind === 'summaries') {
      const text = rec.title + (rec.summary ? '\n' + rec.summary : '')
      if (typeof rec.title === 'string' && rec.title.length > 0 && text.length >= 6) out.push(rec)
    } else {
      out.push(rec)
    }
  }
  return out
}

function walkMarkdown(root) {
  const out = []
  const walk = (dir, prefix) => {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of ents) {
      const rel = prefix ? prefix + '/' + ent.name : ent.name
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel)
      else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(rel)
    }
  }
  walk(root, '')
  return out
}

function auditFileInto(source, filePath, acc) {
  const content = fs.readFileSync(filePath, 'utf8')
  const bytes = Buffer.byteLength(content, 'utf8')
  acc.bytes += bytes
  acc.hashParts.push(filePath + '\0' + content + '\0')

  if (source.format === 'jsonl') {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const records = parseJsonlRecords(source.recordKind, lines)
    if (source.searchable) {
      acc.entries += records.length
      for (const line of lines) {
        const len = Buffer.byteLength(line, 'utf8')
        acc.searchableBytes += len
        if (len > acc.maxEntryBytes) acc.maxEntryBytes = len
      }
    } else {
      acc.statusEntries += records.length
    }
    return
  }

  const entries = splitMarkdownEntries(content)
  if (source.searchable) {
    acc.entries += entries.length
    acc.searchableBytes += bytes
    for (const entry of entries) {
      const len = Buffer.byteLength(entry, 'utf8')
      if (len > acc.maxEntryBytes) acc.maxEntryBytes = len
    }
  } else {
    acc.statusEntries += entries.length
  }
}

function auditDirectoryInto(source, root, acc) {
  const rels = source.include ? [...source.include] : walkMarkdown(root)
  for (const rel of rels) {
    const full = path.join(root, rel)
    let st
    try {
      st = fs.statSync(full)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    if (!st.isFile()) continue
    auditFileInto(source, full, acc)
  }
}

function auditOne(source) {
  const row = {
    id: source.id,
    label: source.label,
    path: source.path,
    required: Boolean(source.required),
    searchable: source.searchable !== false,
    kind: source.kind || null,
    status: 'missing',
    bytes: 0,
    entries: 0,
    statusEntries: 0,
    searchableBytes: 0,
    maxEntryBytes: 0,
    contentHash: null,
  }
  if (!source.path) return row

  let st
  try {
    st = fs.statSync(source.path)
  } catch (err) {
    row.status = err.code === 'ENOENT' ? 'missing' : 'unreadable'
    row.error = err.message
    return row
  }

  if (source.kind === 'file' && !st.isFile()) {
    row.status = 'invalid'
    row.error = '期望普通文件，实际不是'
    return row
  }
  if (source.kind === 'dir' && !st.isDirectory()) {
    row.status = 'invalid'
    row.error = '期望目录，实际不是'
    return row
  }

  const acc = { bytes: 0, entries: 0, statusEntries: 0, searchableBytes: 0, maxEntryBytes: 0, hashParts: [] }
  try {
    if (st.isDirectory()) auditDirectoryInto(source, source.path, acc)
    else auditFileInto(source, source.path, acc)
  } catch (err) {
    row.status = 'unreadable'
    row.error = err.message
    return row
  }

  row.bytes = acc.bytes
  row.entries = acc.entries
  row.statusEntries = acc.statusEntries
  row.searchableBytes = acc.searchableBytes
  row.maxEntryBytes = acc.maxEntryBytes
  row.contentHash = acc.hashParts.length > 0 ? sha256(acc.hashParts.join('')) : null
  const count = row.searchable ? acc.entries : acc.statusEntries
  row.status = count > 0 ? 'present' : 'empty'
  return row
}

/**
 * 审计输入源，并汇总「真正参与检索的条目」。
 * 目录源只统计 include 里列出的文件；memoryRoot 下其他 md（开场、身份等）
 * recall 根本不会读，算进去会让报告虚高。
 */
export function auditSources(sources) {
  const rows = []
  const totals = { searchableEntryCount: 0, statusRecordCount: 0, searchableBytes: 0, maxEntryBytes: 0 }
  for (const source of sources) {
    const row = auditOne(source)
    rows.push(row)
    if (row.status === 'unreadable') continue
    if (row.searchable) totals.searchableEntryCount += row.entries
    else totals.statusRecordCount += row.statusEntries
    totals.searchableBytes += row.searchableBytes
    if (row.maxEntryBytes > totals.maxEntryBytes) totals.maxEntryBytes = row.maxEntryBytes
  }
  return { rows, ...totals }
}

/**
 * real 模式门禁：
 *  - 任何必需源不是 PRESENT（missing/empty/unreadable）→ 失败；
 *  - 任何已存在但不可读的源 → 失败（否则等于悄悄测了残缺语料）；
 *  - 全量可检索条目为 0 → 失败，绝不生成合成语料顶替。
 */
export function gateRealInputs(rows, totals) {
  const errors = []
  for (const row of rows) {
    if (row.status === 'unreadable') {
      errors.push('输入源不可读: ' + row.label + ' (' + row.id + ')' + (row.error ? ' — ' + row.error : ''))
      continue
    }
    if (row.status === 'invalid') {
      errors.push('输入源类型不符: ' + row.label + ' (' + row.id + ')' + (row.error ? ' — ' + row.error : ''))
      continue
    }
    if (row.required && row.status !== 'present') {
      errors.push('必需输入源不可用: ' + row.label + ' (' + row.id + ') 状态=' + row.status)
    }
  }
  if (totals.searchableEntryCount <= 0) {
    errors.push('真实语料里没有任何可检索条目（real 模式不会回退到合成语料）')
  }
  return [...new Set(errors)]
}

/**
 * 生成自包含合成语料。所有内容由 seed 决定：
 * 同一 seed 两次生成的 Markdown 文本、条目数、指纹完全相同；不同 seed 排列不同。
 */
export function buildSyntheticCorpus({ rootDir, seed, probes = DEFAULT_PROBES, reps = 8 }) {
  if (!rootDir) throw new Error('buildSyntheticCorpus 需要 rootDir')
  const order = seededOrder(seed, probes.length)
  const sections = ['## 合成基准语料（脚本生成，不是真实工作区）', '']
  const entryTexts = []
  let n = 0
  for (const probeIndex of order) {
    const probe = probes[probeIndex]
    for (let rep = 1; rep <= reps; rep += 1) {
      n += 1
      const heading = '### ' + probe.q + '与生产实践第 ' + n + ' 节'
      const body =
        '这是关于 ' + probe.expectedKeyword + ' 相关模块的标准描述，包含针对 ' + probe.q +
        ' 的完整实施方案与架构验证要点。'
      sections.push(heading, '', body, '')
      entryTexts.push(body)
    }
  }
  const dialogueText = sections.join('\n')
  const structuredText =
    JSON.stringify({ id: 'mem-bench-1', source_id: 'dialogue:1', status: 'active' }) + '\n'

  const memoryRoot = path.join(rootDir, 'memory')
  const dialogueFile = path.join(rootDir, '对话记录.md')
  const structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
  const summaryStore = path.join(rootDir, 'autocapture', 'summaries.jsonl')
  const autocaptureStore = path.join(rootDir, 'autocapture', 'captures.jsonl')
  fs.mkdirSync(path.join(memoryRoot, '记忆'), { recursive: true })
  fs.writeFileSync(dialogueFile, dialogueText, 'utf8')
  fs.writeFileSync(structuredFile, structuredText, 'utf8')

  const entries = splitMarkdownEntries(dialogueText)
  const dialogueBytes = Buffer.byteLength(dialogueText, 'utf8')
  const maxEntryBytes = entries.reduce((m, e) => Math.max(m, Buffer.byteLength(e, 'utf8')), 0)
  const structuredBytes = Buffer.byteLength(structuredText, 'utf8')

  const rows = [
    {
      id: 'syntheticDialogue',
      label: '合成对话语料',
      path: '<synthetic>/对话记录.md',
      required: true,
      searchable: true,
      status: 'present',
      bytes: dialogueBytes,
      entries: entries.length,
      statusEntries: 0,
      searchableBytes: dialogueBytes,
      maxEntryBytes,
      contentHash: sha256(dialogueText),
      synthetic: true,
    },
    {
      id: 'syntheticStructured',
      label: '合成结构化状态表',
      path: '<synthetic>/memory/记忆/structured.jsonl',
      required: false,
      searchable: false,
      status: 'present',
      bytes: structuredBytes,
      entries: 0,
      statusEntries: 1,
      searchableBytes: 0,
      maxEntryBytes: 0,
      contentHash: sha256(structuredText),
      synthetic: true,
    },
  ]

  return {
    files: { memoryRoot, dialogueFile, structuredFile, summaryStore, autocaptureStore },
    rows,
    totals: {
      searchableEntryCount: entries.length,
      statusRecordCount: 1,
      searchableBytes: dialogueBytes,
      maxEntryBytes,
    },
    entryTexts,
    dialogueText,
    dialogueDigest: sha256(dialogueText),
  }
}

/**
 * 语料 / 工作量指纹：同一 mode + seed + 输入内容 → 同一指纹。
 * 故意不包含时间戳、绝对临时路径和耗时，保证它能横向比对两次运行。
 */
export function workloadDigest({ mode, seed, probes, rows, coldRounds = COLD_ROUNDS, hotRounds = HOT_ROUNDS }) {
  const payload = {
    schema: 'dsh-memory-bench-v1',
    mode,
    seed,
    coldRounds,
    hotRounds,
    probes: probes.map((p) => ({ q: p.q, expectedKeyword: p.expectedKeyword })),
    sources: rows.map((row) => ({
      id: row.id,
      status: row.status,
      bytes: row.bytes,
      entries: row.searchable ? row.entries : row.statusEntries,
      contentHash: row.contentHash || null,
    })),
  }
  return sha256(JSON.stringify(payload))
}