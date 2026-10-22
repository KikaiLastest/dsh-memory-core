import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'

// 分数分解的恒等式：不管扩展有没有被上限截断，账必须对得上。
// 之前的 bug 是只暴露了 expansionScore（截断前的值），没暴露截断后的值，
// 于是 preDecayScore ≠ queryScore + expansionScore，看日志的人会以为算错了。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-contract-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

// 两段语料：一段能靠原始词直接命中，一段只有扩展词能捞到
fs.writeFileSync(
  dialogueFile,
  [
    '## 2026-10-22',
    '',
    '### 数据库选型',
    '',
    '数据库统一使用 PostgreSQL 15，连接串走环境变量注入，不写死在代码里，迁移脚本单独管理。',
    '',
    '### 部署位置',
    '',
    '服务直接部署到生产机 10.0.0.9，测试机那台已经停用，配置也迁移过去了。',
    '',
  ].join('\n'),
  'utf8',
)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const cfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  topK: 5,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

let checked = 0
let sawExpansion = 0
for (const q of ['数据库用的什么', '服务跑在什么环境上', '部署到哪台机器']) {
  const hits = recall(cfg, q, Date.now() + 5000)
  for (const h of hits) {
    checked += 1
    const lhs = h.preDecayScore
    const rhs = h.queryScore + h.effectiveExpansionScore
    assert.ok(
      Math.abs(lhs - rhs) < 1e-9,
      `[${q}] 分数分解对不上：preDecayScore=${lhs} 但 queryScore+effectiveExpansionScore=${rhs}`,
    )
    assert.ok(
      h.effectiveExpansionScore <= h.expansionScore + 1e-9,
      `[${q}] 截断后的扩展分比截断前还大`,
    )
    assert.ok(h.preDecayScore >= h.queryScore - 1e-9, `[${q}] 总分不该小于原始贡献`)
    assert.ok(h.queryScore >= 0 && h.expansionScore >= 0, `[${q}] 分数不该为负`)
    if (h.expansionScore > 0) sawExpansion += 1
  }
}

assert.ok(checked > 0, '一条都没召回，这个测试等于没跑')
assert.ok(sawExpansion > 0, '没有任何查询走到扩展路径，恒等式没被真正验证')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`score contract tests passed (${checked} hits, ${sawExpansion} with expansion)`)
