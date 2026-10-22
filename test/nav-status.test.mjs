import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildNav, clearSummaryCache } from '../summary.mjs'
import { consolidate } from '../consolidate.mjs'

// 常驻导航必须和召回共用同一套状态语义：
// 一条被淘汰的旧决策，不该从召回里消失又在导航里冒出来。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navstatus-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

const body = [
  '## 2026-10-20',
  '',
  '### 早就作废的旧方案',
  '',
  '当时定下来要用的那一套实现方式，后来因为维护成本太高被整体替换掉了。',
  '',
  '### 目前仍在使用的方案',
  '',
  '现在稳定跑着的是这一套方案，部署和日常维护都已经按它的节奏来安排。',
  '',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const cfg = { memoryRoot, dialogueFile, structuredFile, summaryMaxChars: 600, enableSanitize: true }

function navText() {
  clearSummaryCache()
  return buildNav(cfg)
}

// 1) 没标状态时，两个主题都该出现
const before = navText()
assert.ok(before.includes('早就作废的旧方案'), '未标状态时旧主题出现在导航里')
assert.ok(before.includes('目前仍在使用的方案'), '新主题也出现')

// 2) 把旧的那条标成 superseded，导航里必须消失
const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const oldRec = recs.find((r) => r.quote.includes('早就作废的旧方案'))
assert.ok(oldRec, '找到旧方案对应的固化记录')
recs.find((r) => r.id === oldRec.id).status = 'superseded'
fs.writeFileSync(structuredFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const after = navText()
assert.ok(!after.includes('早就作废的旧方案'), '被取代的主题不该再出现在常驻导航里')
assert.ok(after.includes('目前仍在使用的方案'), '仍然有效的主题保留')

// 3) archived / draft 同样不进导航
for (const st of ['archived', 'draft']) {
  const r2 = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  r2.find((r) => r.id === oldRec.id).status = st
  fs.writeFileSync(structuredFile, r2.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  assert.ok(!navText().includes('早就作废的旧方案'), `status=${st} 也不该进导航`)
}

// 4) 全部被淘汰时导航返回空串，而不是硬撑一个空壳
const r3 = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
r3.forEach((r) => {
  r.status = 'superseded'
})
fs.writeFileSync(structuredFile, r3.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
assert.equal(navText(), '', '所有对话小节都失效时导航返回空串')

fs.rmSync(dir, { recursive: true, force: true })
console.log('nav status tests passed')
