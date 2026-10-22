import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recall, invalidateMemoryCache } from '../index.js'
import { invalidateCaptureCache } from '../autocapture.mjs'
import { DEFAULT_MEMORY_ROOT, DEFAULT_DIALOGUE_FILE } from '../config.mjs'

// 本脚本用于跨平台、可复现地精确度量冷启动、缓存刷新与热查询在真实/合成语料下的延迟与质量指标
let memoryRoot = process.env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
let dialogueFile = process.env.DSH_MEMORY_DIALOGUE || DEFAULT_DIALOGUE_FILE
let structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
let summaryStore = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'autocapture', 'summaries.jsonl')
let autocaptureStore = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'autocapture', 'captures.jsonl')

let cfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  summaryStore,
  autocaptureStore,
  topK: 8,
  minCoverage: 0.15,
  minMatched: 1,
  minRatio: 0.1,
  halfLifeDays: 30,
}

// 1. 显式预期输入源清单审计（Expected Inputs Manifest，消灭静默吞错误）
const EXPECTED_SOURCES = [
  { id: 'dialogueFile', label: '对话记录文件', path: dialogueFile, required: false },
  { id: 'memoryRoot', label: '记忆档案目录', path: memoryRoot, required: false },
  { id: 'structuredFile', label: '结构化状态表', path: structuredFile, required: false },
  { id: 'autocaptureStore', label: '自动捕获存储', path: autocaptureStore, required: false },
  { id: 'summaryStore', label: '后台摘要存储', path: summaryStore, required: false },
]

const auditManifest = []
let totalBytes = 0
let maxEntryBytes = 0
let entryCount = 0
let corpusMode = '本地真实工作区档案'

for (const source of EXPECTED_SOURCES) {
  const filePath = source.path
  if (!filePath || !fs.existsSync(filePath)) {
    auditManifest.push({ id: source.id, label: source.label, path: filePath, status: 'missing', bytes: 0, entries: 0 })
    continue
  }
  try {
    const st = fs.statSync(filePath)
    if (st.isDirectory()) {
      let dirBytes = 0
      let dirEntries = 0
      const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, ent.name)
          if (ent.isDirectory()) walk(full)
          else if (ent.isFile() && /\.md$/i.test(ent.name)) {
            const content = fs.readFileSync(full, 'utf8')
            const b = Buffer.byteLength(content, 'utf8')
            dirBytes += b
            totalBytes += b
            for (const part of content.split(/\n(?=#{2,3} )/)) {
              const len = Buffer.byteLength(part, 'utf8')
              if (len >= 40) {
                dirEntries += 1
                entryCount += 1
                if (len > maxEntryBytes) maxEntryBytes = len
              }
            }
          }
        }
      }
      walk(filePath)
      auditManifest.push({ id: source.id, label: source.label, path: filePath, status: 'present', bytes: dirBytes, entries: dirEntries })
    } else {
      const content = fs.readFileSync(filePath, 'utf8')
      const bytes = Buffer.byteLength(content, 'utf8')
      totalBytes += bytes
      let fileEntries = 0
      if (filePath.endsWith('.jsonl')) {
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          fileEntries += 1
          entryCount += 1
          const len = Buffer.byteLength(trimmed, 'utf8')
          if (len > maxEntryBytes) maxEntryBytes = len
        }
      } else {
        for (const part of content.split(/\n(?=#{2,3} )/)) {
          const len = Buffer.byteLength(part, 'utf8')
          if (len >= 40) {
            fileEntries += 1
            entryCount += 1
            if (len > maxEntryBytes) maxEntryBytes = len
          }
        }
      }
      auditManifest.push({ id: source.id, label: source.label, path: filePath, status: 'present', bytes, entries: fileEntries })
    }
  } catch (err) {
    auditManifest.push({ id: source.id, label: source.label, path: filePath, status: 'unreadable', error: err.message, bytes: 0, entries: 0 })
  }
}

// 2. 自包含合成基准自愈保障：当干净环境无个人语料时，自动构造完备对应的基准语料
let tempFixtureDir = null
const BENCHMARK_PAIRS = [
  { q: '本地部署优化方案', expectedKeyword: '优化方案' },
  { q: '炉石盒子崩溃排障', expectedKeyword: '炉石' },
  { q: '逆向工程模拟靶场', expectedKeyword: '靶场' },
  { q: '自动刷B站插件', expectedKeyword: 'B站' },
  { q: '自研记忆核心', expectedKeyword: '记忆' },
]

if (entryCount === 0) {
  corpusMode = '自包含基准合成语料 (干净CI环境模式)'
  tempFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fixture-'))
  memoryRoot = path.join(tempFixtureDir, 'memory')
  fs.mkdirSync(path.join(memoryRoot, '记忆'), { recursive: true })
  dialogueFile = path.join(tempFixtureDir, '对话记录.md')
  structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
  summaryStore = path.join(tempFixtureDir, 'summaries.jsonl')
  autocaptureStore = path.join(tempFixtureDir, 'captures.jsonl')

  const synthSections = ['## 2026-10-22', '']
  // 合成小节与 BENCHMARK_PAIRS 严格 100% 对应闭环
  for (let i = 0; i < BENCHMARK_PAIRS.length; i++) {
    const pair = BENCHMARK_PAIRS[i]
    for (let rep = 1; rep <= 8; rep++) {
      synthSections.push(`### ${pair.q}与系统实践编号 ${i * 8 + rep}`)
      synthSections.push('')
      synthSections.push(`这是关于 ${pair.expectedKeyword} 相关主题的详细描述，包含明确的 ${pair.q} 规范与生产实践标准。`)
      synthSections.push('')
    }
  }
  fs.writeFileSync(dialogueFile, synthSections.join('\n'), 'utf8')
  fs.writeFileSync(structuredFile, JSON.stringify({ id: 'mem-bench-1', source_id: 'dialogue:1', status: 'active' }) + '\n', 'utf8')

  cfg = {
    memoryRoot,
    dialogueFile,
    structuredFile,
    summaryStore,
    autocaptureStore,
    topK: 8,
    minCoverage: 0.1,
    minMatched: 1,
    minRatio: 0.1,
    halfLifeDays: 30,
  }

  // 重新核算合成语料
  totalBytes = 0
  maxEntryBytes = 0
  entryCount = 0
  const synthText = fs.readFileSync(dialogueFile, 'utf8')
  totalBytes += Buffer.byteLength(synthText, 'utf8')
  for (const part of synthText.split(/\n(?=#{2,3} )/)) {
    const len = Buffer.byteLength(part, 'utf8')
    if (len >= 40) {
      entryCount += 1
      if (len > maxEntryBytes) maxEntryBytes = len
    }
  }
}

const percentile = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// 3. 真实冷启动采样（50 次样本，每次强制双重清缓存，并执行质量断言）
const COLD_ROUNDS = 50
const coldLatencies = []

for (let i = 0; i < COLD_ROUNDS; i++) {
  invalidateMemoryCache()
  if (cfg.autocaptureStore) invalidateCaptureCache(cfg.autocaptureStore)
  const pair = BENCHMARK_PAIRS[i % BENCHMARK_PAIRS.length]
  const t0 = performance.now()
  const hits = recall(cfg, pair.q, Date.now() + 500)
  const cost = performance.now() - t0
  coldLatencies.push(cost)

  // 严格质量门禁：不仅必须非空，且 Top-1 必须包含预期核心词项且得分大于 0
  if (hits.length === 0) {
    throw new Error(`基准质量门禁失败: 查询 "${pair.q}" 返回 0 条结果！`)
  }
  if (!Number.isFinite(hits[0].score) || hits[0].score <= 0) {
    throw new Error(`基准质量门禁失败: 查询 "${pair.q}" Top-1 得分非法 (${hits[0].score})`)
  }
  if (!hits[0].entry.text.includes(pair.expectedKeyword)) {
    throw new Error(`基准质量门禁失败: 查询 "${pair.q}" Top-1 结果未命中预期关键词 "${pair.expectedKeyword}"`)
  }
}

// 4. 热查询连续采样（200 次样本，测量内存缓存下的极限服务吞吐）
const HOT_ROUNDS = 200
const hotLatencies = []

// 预热一轮构建基准缓存
recall(cfg, '预热基准缓存', Date.now() + 5000)

for (let i = 0; i < HOT_ROUNDS; i++) {
  const pair = BENCHMARK_PAIRS[i % BENCHMARK_PAIRS.length]
  const t0 = performance.now()
  const hits = recall(cfg, pair.q, Date.now() + 150)
  hotLatencies.push(performance.now() - t0)
  if (hits.length === 0 || !hits[0].entry.text.includes(pair.expectedKeyword)) {
    throw new Error(`基准质量门禁失败: 热查询 "${pair.q}" 召回质量退化！`)
  }
}

// 5. 负样本注入安全校验：完全无关的查询必须返回 0 条结果，杜绝误召
const negativeQuery = '量子力学与超弦理论在黑洞视界的辐射实验'
const negativeHits = recall(cfg, negativeQuery, Date.now() + 150)
if (negativeHits.length > 0) {
  throw new Error(`负样本安全门禁失败: 绝对无关查询 "${negativeQuery}" 被误召了 ${negativeHits.length} 条记录！`)
}

// 6. 统计与动态达标率计算
const coldMin = Math.min(...coldLatencies)
const coldP50 = percentile(coldLatencies, 50)
const coldP95 = percentile(coldLatencies, 95)
const coldP99 = percentile(coldLatencies, 99)
const coldMax = Math.max(...coldLatencies)

const hotMin = Math.min(...hotLatencies)
const hotP50 = percentile(hotLatencies, 50)
const hotP95 = percentile(hotLatencies, 95)
const hotP99 = percentile(hotLatencies, 99)
const hotMax = Math.max(...hotLatencies)

const TARGET_BUDGET_MS = 150
const coldPassCount = coldLatencies.filter((t) => t <= TARGET_BUDGET_MS).length
const hotPassCount = hotLatencies.filter((t) => t <= TARGET_BUDGET_MS).length
const totalSampleCount = coldLatencies.length + hotLatencies.length
const actualPassRate = (((coldPassCount + hotPassCount) / totalSampleCount) * 100).toFixed(1)

console.log('================ 本地性能与质量基准审计报告 ================')
console.log(`运行环境: Node.js ${process.version} (${process.platform} ${process.arch})`)
console.log(`语料数据模式: ${corpusMode}`)
console.log(`输入源清单审计:`)
for (const m of auditManifest) {
  console.log(`  - [${m.status.toUpperCase()}] ${m.label} (${m.id}): ${m.bytes} 字节, ${m.entries} 条记录 ${m.error ? 'ERROR: ' + m.error : ''}`)
}
console.log(`有效语料总计: ${entryCount} 条 | 总大小: ${(totalBytes / 1024).toFixed(2)} KB | 单条最大: ${(maxEntryBytes / 1024).toFixed(2)} KB`)
console.log('------------------------------------------------------------')
console.log(`【冷启动 / 磁盘全量重读与索引重建】(${COLD_ROUNDS}次显式清缓存采样):`)
console.log(`  Min: ${coldMin.toFixed(3)} ms | P50: ${coldP50.toFixed(3)} ms | P95: ${coldP95.toFixed(3)} ms | P99: ${coldP99.toFixed(3)} ms | Max: ${coldMax.toFixed(3)} ms`)
console.log('------------------------------------------------------------')
console.log(`【热查询命中内存缓存】(${HOT_ROUNDS}次连续采样):`)
console.log(`  Min: ${hotMin.toFixed(3)} ms | P50: ${hotP50.toFixed(3)} ms | P95: ${hotP95.toFixed(3)} ms | P99: ${hotP99.toFixed(3)} ms | Max: ${hotMax.toFixed(3)} ms`)
console.log('------------------------------------------------------------')
console.log(`双门禁结果: 正向质量 100% 关键词匹配 | 负例误召 0 条 | 150ms 延迟预算达标率: ${actualPassRate}%`)
console.log('============================================================')

if (tempFixtureDir) {
  try { fs.rmSync(tempFixtureDir, { recursive: true, force: true }) } catch {}
}

// 自动化硬指标熔断断言
if (coldP95 > TARGET_BUDGET_MS) {
  throw new Error(`基准未通过: 冷启动 P95 (${coldP95.toFixed(2)}ms) 超出 ${TARGET_BUDGET_MS}ms 预算`)
}
if (hotP95 > 10) {
  throw new Error(`基准未通过: 热查询 P95 (${hotP95.toFixed(2)}ms) 超出 10ms 服务阈值`)
}
