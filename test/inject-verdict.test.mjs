import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall, recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

// 注入路径必须走 verdict，不能只看 hits 非空。
//
// 这条测试锁两件事：
//   1. 行为：语料里根本没有答案时，verdict 是 abstain
//      ——即使 recall() 因为词面巧合返回了候选（那正是必须拦住的情况）
//   2. 结构：agent/pre-step 段里不许再出现裸 recall( 调用
//
// 结构化断言是弱证据，但它能挡住「以后有人图省事改回 recall()」。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-verdict-'))
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
    '### 部署方式',
    '',
    '服务跑在自己的机器上，用 systemd 拉起，端口 8080。',
    '',
    '### 缓存',
    '',
    '静态资源走强缓存，接口响应走协商缓存。',
    '',
  ].join('\n'),
  'utf8',
)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const cfg = {
  memoryRoot, dialogueFile, structuredFile,
  topK: 5, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30,
}

// --- 1. 行为：无答案查询 ---
// 语料里只有部署和缓存，没有任何饮食、家庭、宠物信息。
const q = '我爸的降压药放在哪个柜子了'
const r = recallWithVerdict(cfg, q, Date.now() + 5000)
assert.equal(typeof r.verdict, 'string')
assert.ok(['answer', 'ambiguous', 'abstain'].includes(r.verdict), 'verdict 必须是三个枚举之一，实际 ' + r.verdict)
assert.equal(r.verdict, 'abstain', '语料里没有答案，verdict 必须是 abstain，实际 ' + r.verdict + ' reason=' + r.reason)

// hits 允许非空——这正是需要拦截的情况：找到了词面巧合，但证据不够。
// 反过来如果 hits 恰好为空也正常。两种都不能导致注入。
assert.ok(Array.isArray(r.hits), 'hits 必须是数组')

// evidenceStrength 是 0，且不暴露 confidence
assert.equal(r.evidenceStrength, 0, 'abstain 的 evidenceStrength 必须是 0')
assert.equal('confidence' in r, false, 'recallWithVerdict 不该暴露 confidence 那个容易误读的名字')

// --- 2. 一致性：hits 必须和 recall() 完全一致 ---
const plain = recall(cfg, q, Date.now() + 5000)
assert.deepEqual(
  r.hits.map((h) => h.entry.id),
  plain.map((h) => h.entry.id),
  'recallWithVerdict 的 hits 必须和 recall() 完全一致',
)

// --- 3. 结构：注入路径不许再直接调 recall() ---
const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const preStepAt = src.indexOf("'agent/pre-step'")
assert.ok(preStepAt > 0, '找不到 agent/pre-step，结构测试失效')
// 取 pre-step 注册到文件末尾之间的一段（注册回调是最后一段逻辑）
const tail = src.slice(preStepAt)
assert.ok(
  tail.includes('recallWithVerdict('),
  '注入路径必须调用 recallWithVerdict()，否则 verdict 又变回摆设',
)
// 裸 recall( 调用：排除 recallWithVerdict( 和注释里的说明
const bare = tail.match(/(?<!WithVerdict)(?<![\w.])recall\(/g) || []
assert.equal(
  bare.length,
  0,
  '注入路径里出现了 ' + bare.length + ' 处裸 recall( 调用，verdict 被绕过了',
)
assert.ok(
  tail.includes("verdict === 'abstain'"),
  '注入路径必须有 abstain 分支',
)

fs.rmSync(dir, { recursive: true, force: true })
console.log('inject-verdict test passed (verdict=' + r.verdict + ', reason=' + r.reason + ')')
