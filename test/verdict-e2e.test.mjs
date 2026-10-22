import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall, recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

// 端到端：真实语料 -> 真实 recall -> 真实判定。
// abstain.test.mjs 用手写 hit 数组测的是规则本身；
// 这里测的是「用户真问一句，走完整条路，最后拿到什么 verdict」。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-e2e-'))
const memoryRoot = path.join(dir, 'memory')
const sd = path.join(memoryRoot, '记忆')
fs.mkdirSync(sd, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(sd, 'structured.jsonl')
const watermarkFile = path.join(sd, '.watermark.json')

fs.writeFileSync(
  dialogueFile,
  [
    '## 2026-10-22',
    '',
    '### 数据库选型',
    '',
    '数据库统一使用 PostgreSQL 15，连接串走环境变量注入，不写死在代码里，迁移脚本单独管理。',
    '',
    '### 服务端口',
    '',
    '服务监听的端口是 8443，前面有一层反向代理，证书统一由网关那边管理，不要在前端写死。',
    '',
  ].join('\n'),
  'utf8',
)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

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

// 1) 有答案：应判 answer，且 hits 和 recall() 完全一致
const ok = recallWithVerdict(cfg, '数据库用的什么', Date.now() + 5000)
assert.equal(typeof ok.verdict, 'string')
assert.equal(ok.verdict, 'answer', '清晰的查询应判 answer，实际 ' + ok.verdict + ' (' + ok.reason + ')')
assert.ok(ok.hits.length > 0, 'answer 必须真的有命中')
assert.deepEqual(
  ok.hits.map((h) => h.entry.id),
  recall(cfg, '数据库用的什么', Date.now() + 5000).map((h) => h.entry.id),
  'recallWithVerdict 的 hits 必须和 recall 完全一致，不能自己过滤一遍',
)

// 2) 无答案：应判 abstain
const none = recallWithVerdict(cfg, '量子纠缠的退相干时间是多少', Date.now() + 5000)
assert.equal(none.verdict, 'abstain', '语料里没答案应判 abstain，实际 ' + none.verdict + ' (' + none.reason + ')')
assert.equal(none.evidenceStrength, 0, 'abstain 时证据强度必须是 0')

// 3) 证据强度只在 0–1，且不是概率
assert.ok(ok.evidenceStrength > 0 && ok.evidenceStrength <= 1)
assert.equal(typeof ok.evidenceStrength, 'number')

// 4) 公开字段里不该出现 confidence 这个容易误读的名字
assert.ok(!('confidence' in ok), 'recallWithVerdict 不应暴露 confidence，它没校准过')

fs.rmSync(dir, { recursive: true, force: true })
console.log('verdict e2e tests passed (answer / abstain / 强度边界)')
