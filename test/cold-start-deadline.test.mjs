import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'

// 针对审查 P0：验证 deadline 超时预算必须覆盖完整的冷启动路径（文件读取与倒排构建阶段）。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-start-'))
const memoryRoot = path.join(dir, 'memory')
fs.mkdirSync(memoryRoot, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')

// 构造 30 个小节的语料库
const sections = ['## 2026-10-22', '']
for (let i = 1; i <= 30; i++) {
  sections.push(`### 小节主题编号 ${i}`)
  sections.push('')
  sections.push(`这是关于系统架构设计与冷启动性能的第 ${i} 段长描述文本，包含足够的字符长度以参与正常切分与倒排索引构建。`)
  sections.push('')
}
fs.writeFileSync(dialogueFile, sections.join('\n'), 'utf8')

const cfg = {
  dialogueFile,
  memoryRoot,
  structuredFile: path.join(memoryRoot, '记忆', 'structured.jsonl'),
  topK: 5,
  minCoverage: 0.1,
  minMatched: 1,
  minRatio: 0.1,
}

// ── 1. 过去时间戳 deadline：冷启动必须在构建前/加载中立刻退出 ─────────
const pastDeadline = Date.now() - 10
const coldHits = recall(cfg, '系统架构设计', pastDeadline)
assert.deepEqual(coldHits, [], '冷启动遇到过去截止时间必须返回空，不能抛错或挂起')

// ── 2. 正常充裕时间：冷启动成功并完成索引构建 ──────────────────────────
const normalHits = recall(cfg, '系统架构设计', Date.now() + 5000)
assert.ok(normalHits.length > 0, `正常预算下必须成功召回，实际命中了 ${normalHits.length} 条`)

// ── 3. 热查询命中缓存：延迟极低且结果稳定 ─────────────────────────────
const hotStart = Date.now()
const hotHits = recall(cfg, '系统架构设计', hotStart + 150)
const hotCost = Date.now() - hotStart
assert.equal(hotHits.length, normalHits.length, '热查询结果与冷启动结果必须一致')
assert.ok(hotCost <= 50, `热查询应在缓存中极速完成，实际耗时: ${hotCost}ms`)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('cold start deadline tests passed')
