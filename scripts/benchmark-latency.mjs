import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recall, invalidateMemoryCache } from '../index.js'

// 本脚本用于精确、可复现地度量冷启动、缓存刷新与热查询在真实语料下的 P50 / P95 / P99 延迟指标
const workspace = 'D:\\dsh-workspace'
const memoryRoot = path.join(workspace, 'memory')
const dialogueFile = path.join(workspace, '对话记录.md')
const structuredFile = path.join(memoryRoot, '记忆', 'structured.jsonl')
const summaryStore = path.join(os.homedir(), '.dsh', 'autocapture', 'summaries.jsonl')
const autocaptureStore = path.join(os.homedir(), '.dsh', 'autocapture', 'captures.jsonl')

const cfg = {
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

// 1. 真实语料体量核算
let totalBytes = 0
let maxEntryBytes = 0
let entryCount = 0

const countFile = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    totalBytes += Buffer.byteLength(text, 'utf8')
    for (const part of text.split(/\n(?=#{2,3} )/)) {
      const len = Buffer.byteLength(part, 'utf8')
      if (len >= 40) {
        entryCount += 1
        if (len > maxEntryBytes) maxEntryBytes = len
      }
    }
  } catch {}
}

countFile(dialogueFile)
countFile(path.join(memoryRoot, '日记.md'))
countFile(path.join(memoryRoot, '生长', '状态.md'))
countFile(path.join(memoryRoot, '生长', '生长记录.md'))

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

// 2. 真实冷启动采样（每次调用前显式清空内存全局单例缓存，强制全量读盘与倒排重建）
const COLD_ROUNDS = 30
const coldLatencies = []

for (let i = 0; i < COLD_ROUNDS; i++) {
  invalidateMemoryCache() // 核心：显式破坏内存单例，保证 100% 发生真实冷启动
  const q = queries[i % queries.length]
  const t0 = performance.now()
  const hits = recall(cfg, q, Date.now() + 500)
  const cost = performance.now() - t0
  coldLatencies.push(cost)
  if (cost > 0 && hits.length === 0 && q.includes('技术栈')) {
    throw new Error(`冷启动在充裕时间下未召回相关记忆: round ${i}`)
  }
}

// 3. 热查询延迟采样（150 次连续请求，测量内存缓存下的极限服务吞吐）
const HOT_ROUNDS = 150
const hotLatencies = []

// 预热一轮
recall(cfg, '预热基准缓存', Date.now() + 5000)

for (let i = 0; i < HOT_ROUNDS; i++) {
  const q = queries[i % queries.length]
  const t0 = performance.now()
  recall(cfg, q, Date.now() + 150)
  hotLatencies.push(performance.now() - t0)
}

// 4. 真实统计与计算（绝无硬编码）
const coldP50 = percentile(coldLatencies, 50)
const coldP95 = percentile(coldLatencies, 95)
const coldP99 = percentile(coldLatencies, 99)
const coldMax = Math.max(...coldLatencies)

const hotP50 = percentile(hotLatencies, 50)
const hotP95 = percentile(hotLatencies, 95)
const hotP99 = percentile(hotLatencies, 99)
const hotMax = Math.max(...hotLatencies)

const TARGET_BUDGET_MS = 150
const coldPassCount = coldLatencies.filter((t) => t <= TARGET_BUDGET_MS).length
const hotPassCount = hotLatencies.filter((t) => t <= TARGET_BUDGET_MS).length
const totalSampleCount = coldLatencies.length + hotLatencies.length
const actualPassRate = (((coldPassCount + hotPassCount) / totalSampleCount) * 100).toFixed(1)

console.log('================ 真实可复现性能基准审计报告 ================')
console.log(`运行环境: Node.js ${process.version} (${process.platform} ${process.arch})`)
console.log(`语料规模: ${entryCount} 条小节 | 总大小: ${(totalBytes / 1024).toFixed(2)} KB | 最长单条: ${(maxEntryBytes / 1024).toFixed(2)} KB`)
console.log('------------------------------------------------------------')
console.log(`【真实冷启动 / 全量磁盘与索引重建】(${COLD_ROUNDS}次显式清缓存采样):`)
console.log(`  P50: ${coldP50.toFixed(3)} ms | P95: ${coldP95.toFixed(3)} ms | P99: ${coldP99.toFixed(3)} ms | Max: ${coldMax.toFixed(3)} ms`)
console.log('------------------------------------------------------------')
console.log(`【热查询命中内存缓存】(${HOT_ROUNDS}次连续采样):`)
console.log(`  P50: ${hotP50.toFixed(3)} ms | P95: ${hotP95.toFixed(3)} ms | P99: ${hotP99.toFixed(3)} ms | Max: ${hotMax.toFixed(3)} ms`)
console.log('------------------------------------------------------------')
console.log(`150ms 延迟预算达标率: ${actualPassRate}% (${coldPassCount + hotPassCount}/${totalSampleCount} 样本 ≤ ${TARGET_BUDGET_MS}ms)`)
console.log('============================================================')

// 自动化硬指标熔断断言：冷启动 P95 超过 150ms 或热查询 P95 超过 10ms 直接挂掉测试
if (coldP95 > TARGET_BUDGET_MS) {
  throw new Error(`性能不达标: 冷启动 P95 (${coldP95.toFixed(2)}ms) 超出 ${TARGET_BUDGET_MS}ms 预算`)
}
if (hotP95 > 10) {
  throw new Error(`性能不达标: 热查询 P95 (${hotP95.toFixed(2)}ms) 超出 10ms 限制`)
}
