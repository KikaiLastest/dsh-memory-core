import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recall, invalidateMemoryCache } from '../index.js'
import { invalidateCaptureCache } from '../autocapture.mjs'
import { DEFAULT_MEMORY_ROOT, DEFAULT_DIALOGUE_FILE } from '../config.mjs'

// 本脚本用于跨平台、可复现地精确度量冷启动、缓存刷新与热查询在真实/合成语料下的延迟指标
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
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

// 1. 全量数据源核算
let totalBytes = 0
let maxEntryBytes = 0
let entryCount = 0
let corpusMode = '本地真实工作区档案'
const auditedFiles = []

const countTextFile = (file) => {
  if (!file) return
  try {
    if (!fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    totalBytes += bytes
    auditedFiles.push({ path: file, bytes, type: 'markdown' })
    for (const part of text.split(/\n(?=#{2,3} )/)) {
      const len = Buffer.byteLength(part, 'utf8')
      if (len >= 40) {
        entryCount += 1
        if (len > maxEntryBytes) maxEntryBytes = len
      }
    }
  } catch {}
}

const countJsonlFile = (file) => {
  if (!file) return
  try {
    if (!fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    totalBytes += bytes
    let fileEntries = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      fileEntries += 1
      entryCount += 1
      const len = Buffer.byteLength(trimmed, 'utf8')
      if (len > maxEntryBytes) maxEntryBytes = len
    }
    auditedFiles.push({ path: file, bytes, entries: fileEntries, type: 'jsonl' })
  } catch {}
}

// 统计实际输入源
countTextFile(dialogueFile)
try {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile() && /\.md$/i.test(ent.name)) countTextFile(full)
    }
  }
  walk(memoryRoot)
} catch {}

countJsonlFile(autocaptureStore)
countJsonlFile(summaryStore)
countJsonlFile(structuredFile)

// 如果在全新的 CI 或无个人档案机器上运行，自动自愈构建自包含的合成基准语料
let tempFixtureDir = null
if (entryCount === 0) {
  corpusMode = '自包含基准合成语料 (CI/干净环境模式)'
  tempFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fixture-'))
  memoryRoot = path.join(tempFixtureDir, 'memory')
  fs.mkdirSync(path.join(memoryRoot, '记忆'), { recursive: true })
  dialogueFile = path.join(tempFixtureDir, '对话记录.md')
  structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
  summaryStore = path.join(tempFixtureDir, 'summaries.jsonl')
  autocaptureStore = path.join(tempFixtureDir, 'captures.jsonl')

  const synthSections = ['## 2026-10-22', '']
  for (let i = 1; i <= 60; i++) {
    synthSections.push(`### 技术栈选型方案与架构第 ${i} 节`)
    synthSections.push('')
    synthSections.push(`这是关于系统性能与召回基准的标准化合成语料内容，包含详尽的关键词描述以支撑基准测试 ${i}。`)
    synthSections.push('')
  }
  fs.writeFileSync(dialogueFile, synthSections.join('\n'), 'utf8')
  fs.writeFileSync(structuredFile, JSON.stringify({ id: 'mem-bench-1', source_id: 'dialogue:1', status: 'active' }) + '\n', 'utf8')
  fs.writeFileSync(summaryStore, JSON.stringify({ id: 'sum-1', title: '香菜葱花忌口偏好', summary: '用户明确偏好不要放香菜', source_id: 'dialogue:20' }) + '\n', 'utf8')

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
  auditedFiles.length = 0
  countTextFile(dialogueFile)
  countJsonlFile(structuredFile)
  countJsonlFile(summaryStore)
}

const percentile = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

const queries = [
  '技术栈选型方案',
  '数据库连接配置',
  '自动刷B站插件',
  '情绪状态衰减机制',
  '逆向工程模拟靶场',
  '炉石盒子崩溃排障',
  '如何部署本地模型',
  '香菜葱花忌口偏好',
]

// 2. 真实冷启动采样（50 次样本，每次强制同时清空主索引与捕获文件缓存）
const COLD_ROUNDS = 50
const coldLatencies = []

for (let i = 0; i < COLD_ROUNDS; i++) {
  invalidateMemoryCache()
  if (cfg.autocaptureStore) invalidateCaptureCache(cfg.autocaptureStore)
  const q = queries[i % queries.length]
  const t0 = performance.now()
  const hits = recall(cfg, q, Date.now() + 500)
  const cost = performance.now() - t0
  coldLatencies.push(cost)
}

// 3. 热查询连续采样（200 次样本，测量内存缓存下的吞吐）
const HOT_ROUNDS = 200
const hotLatencies = []

// 预热一轮构建基准缓存
recall(cfg, '预热基准缓存', Date.now() + 5000)

for (let i = 0; i < HOT_ROUNDS; i++) {
  const q = queries[i % queries.length]
  const t0 = performance.now()
  recall(cfg, q, Date.now() + 150)
  hotLatencies.push(performance.now() - t0)
}

// 4. 统计与动态达标率计算（严格剔除任何硬编码）
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

console.log('================ 本地性能基准审计报告 ================')
console.log(`运行环境: Node.js ${process.version} (${process.platform} ${process.arch})`)
console.log(`语料数据模式: ${corpusMode}`)
console.log(`输入源审计: ${auditedFiles.length} 个文件 | 有效条目: ${entryCount} 条 | 总大小: ${(totalBytes / 1024).toFixed(2)} KB | 单条最大: ${(maxEntryBytes / 1024).toFixed(2)} KB`)
console.log('------------------------------------------------------')
console.log(`【冷启动 / 磁盘全量重读与索引重建】(${COLD_ROUNDS}次显式清缓存采样):`)
console.log(`  Min: ${coldMin.toFixed(3)} ms | P50: ${coldP50.toFixed(3)} ms | P95: ${coldP95.toFixed(3)} ms | P99: ${coldP99.toFixed(3)} ms | Max: ${coldMax.toFixed(3)} ms`)
console.log('------------------------------------------------------')
console.log(`【热查询命中内存缓存】(${HOT_ROUNDS}次连续采样):`)
console.log(`  Min: ${hotMin.toFixed(3)} ms | P50: ${hotP50.toFixed(3)} ms | P95: ${hotP95.toFixed(3)} ms | P99: ${hotP99.toFixed(3)} ms | Max: ${hotMax.toFixed(3)} ms`)
console.log('------------------------------------------------------')
console.log(`150ms 延迟预算达标率: ${actualPassRate}% (${coldPassCount + hotPassCount}/${totalSampleCount} 样本 ≤ ${TARGET_BUDGET_MS}ms)`)
console.log('======================================================')

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
