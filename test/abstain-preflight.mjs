import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, recall, recallWithVerdict } from '../index.js'
import { decide, VERDICT, REASON } from '../abstain.mjs'
import { consolidate } from '../consolidate.mjs'

/**
 * abstain 的 shadow 模式集成测试。
 *
 * 背景（评审 P0）：agent/pre-step 目前直接调 recall()，只要 hits 非空就注入，
 * recallWithVerdict() 算出来的 verdict 只被测试和面板用到，主路径没用。
 *
 * 这个测试**不改 index.js**，而是模拟「pre-step 已经接上 verdict」之后的行为：
 *   1) 用真实 apply() 注册的真实 pre-step 处理器跑出真实注入结果；
 *   2) 对同一个查询、同一份 cfg 调 recallWithVerdict()，拿到真实 verdict；
 *   3) 按 GATE 把 abstain 的注入块从消息列表里摘掉，断言摘掉之后确实没有注入。
 *
 * 所以它验证的是门本身（verdict=abstain ⇒ 不注入），不是「当前主路径已经接好了」。
 * 实施说明与取舍（含开发集代价）见 docs/ABSTAIN-INTEGRATION.md。
 */

// verdict -> 注入策略。answer / ambiguous 都该继续注入：
// ambiguous 只表示分不出主次，证据线已经过了，不该把候选也吞掉。
const GATE = Object.freeze({
  [VERDICT.ANSWER]: 'inject',
  [VERDICT.AMBIGUOUS]: 'inject',
  [VERDICT.ABSTAIN]: 'skip',
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abstain-shadow-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
const logFile = path.join(dir, 'recall.log')
const stateFile = path.join(dir, 'state.json')

// 两节语料，都是 40 字以上；下面两条查询分别走严格通道和回退通道。
const body = [
  '## 2026-10-22',
  '',
  '### 服务端口',
  '',
  '服务监听的端口是 8443，前面有一层反向代理，证书统一由网关那边管理，不要在前端代码里写死。',
  '',
  '### 数据库选型',
  '',
  '数据库统一使用 PostgreSQL 15，连接串走环境变量注入，不写死在代码里，迁移脚本单独管理。',
  '',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const pluginCfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  stateFile,
  logFile,
  autocaptureStore: path.join(dir, 'captures.jsonl'),
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  enableSummary: false,
  enableMemoryNav: false,
  enableAutoCapture: false,
}

// ── 真实插件注册（mock 宿主），拿真实 pre-step 处理器 ──────────────
const handlers = []
const ctx = {
  inject: (deps, fn) => fn({ systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 } }),
  on: (ev, fn) => {
    if (ev === 'agent/pre-step') handlers.push(fn)
  },
  effect: (fn) => fn(),
}
apply(ctx, pluginCfg)
assert.equal(handlers.length, 1, 'pre-step 钩子已注册')

const isRecallMessage = (m) => Boolean(m && m.source && m.source.kind === 'memory-recall')

function textOf(message) {
  const c = message && message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((x) => x && x.type === 'text')
      .map((x) => x.text)
      .join('\n')
  }
  return ''
}

async function preStep(text) {
  const payload = { step: 1, sessionId: 'abstain-shadow' }
  const next = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })
  const decision = await handlers[0](payload, next)
  return decision
}

/**
 * shadow：把 verdict 门叠在真实 pre-step 结果上，返回「如果接上 verdict 会怎样」。
 * 只摘 memory-recall 消息；用户消息与 decision 其他部分原样保留。
 */
async function shadowPreStep(query) {
  const before = await preStep(query)
  const verdict = recallWithVerdict(pluginCfg, query, Date.now() + 5000)
  const action = GATE[verdict.verdict]
  assert.ok(action, '未知 verdict：' + verdict.verdict)
  const messages =
    action === 'skip'
      ? (before.messages || []).filter((m) => !isRecallMessage(m))
      : before.messages || []
  return {
    before,
    verdict,
    action,
    messages,
    injectedBefore: (before.messages || []).some(isRecallMessage),
    injectedAfter: messages.some(isRecallMessage),
    textBefore: (before.messages || []).filter(isRecallMessage).map(textOf).join('\n'),
    textAfter: messages.filter(isRecallMessage).map(textOf).join('\n'),
  }
}

// ── 1. 证据过线：answer 必须照旧注入 ────────────────────────────
{
  const q = '数据库用的什么'
  const s = await shadowPreStep(q)
  assert.equal(s.verdict.verdict, 'answer', '清晰查询应判 answer，实际 ' + s.verdict.verdict + ' (' + s.verdict.reason + ')')
  assert.ok(s.verdict.hits.length > 0, 'answer 必须真的有命中')
  assert.equal(s.action, 'inject')
  assert.equal(s.injectedBefore, true, '当前 pre-step 对 answer 应注入')
  assert.equal(s.injectedAfter, true, 'shadow 门不该吞掉 answer')
  assert.ok(s.textAfter.includes('PostgreSQL'), 'answer 的注入内容应保留命中正文')
}

// ── 2. 回退通道的弱候选：verdict=abstain ⇒ shadow 不注入 ────────
// 「服务在哪个环境跑」的原始 2-gram 只命中「服务」一个，
// 回退通道靠同义词组把它扩展出来，于是 recall() 返回 1 条；
// 但证据线（matched ≥ 2）没过，decide() 判 weak-matched。
{
  const q = '服务在哪个环境跑'
  const s = await shadowPreStep(q)
  const weak = s.verdict.hits
  assert.equal(weak.length, 1, '该查询应由回退通道返回 1 条，实际 ' + weak.length + ' 条')
  assert.equal(s.verdict.verdict, 'abstain', '证据线没过应判 abstain，实际 ' + s.verdict.verdict)
  assert.equal(s.verdict.reason, REASON.WEAK_MATCHED)
  assert.ok(weak[0].queryMatched < pluginCfg.minMatched, '弱候选的原始命中数应低于 minMatched')
  assert.equal(s.action, 'skip')
  assert.equal(s.injectedAfter, false, 'verdict=abstain 时 shadow 路径不能再注入')
  assert.ok(!s.textAfter.includes('8443'), '被拒的弱证据内容不该出现在 shadow 消息里')
  assert.ok(s.messages.some((m) => m && m.role === 'user'), '只摘召回消息，不吞用户消息')
  // 当前主路径还没接 verdict（评审 P0）：这里只打印观察结果，不做断言，
  // 免得把「已知缺口」写成必须保持的错误行为。
  console.log('shadow weak-candidate case: current pre-step injected = ' + s.injectedBefore)
}

// ── 3. 完全没有命中：abstain(no-hits) 与旧行为一致（都不注入） ──
{
  const q = '量子纠缠的退相干时间是多少'
  const s = await shadowPreStep(q)
  assert.equal(s.verdict.verdict, 'abstain')
  assert.equal(s.verdict.reason, REASON.NO_HITS)
  assert.equal(s.verdict.hits.length, 0)
  assert.equal(s.injectedBefore, false)
  assert.equal(s.injectedAfter, false)
}

// ── 4. 契约：shadow 看的 hits 必须与 recall() 完全一致 ─────────
// 主路径调的是 recall()；shadow 调 recallWithVerdict()。两者 hits 不一致的话，
// 这道门就是在拿另一份数据做判断。
{
  const q = '服务在哪个环境跑'
  const a = recall(pluginCfg, q, Date.now() + 5000)
  const b = recallWithVerdict(pluginCfg, q, Date.now() + 5000).hits
  assert.deepEqual(
    a.map((h) => h.entry.id),
    b.map((h) => h.entry.id),
    'shadow 的候选必须来自主路径同一份 recall',
  )
}

// ── 5. 策略表：ambiguous 继续注入（不能和 abstain 混为一谈） ─────
{
  const query = '数据库用的什么'
  const tied = decide(
    [
      { entry: { id: 'x', text: 'A', source_id: 's:1' }, score: 10, coverage: 0.5, queryMatched: 4, matched: 4, preDecayScore: 10, expansionMatched: 0 },
      { entry: { id: 'y', text: 'B', source_id: 's:2' }, score: 9.6, coverage: 0.5, queryMatched: 4, matched: 4, preDecayScore: 9.6, expansionMatched: 0 },
    ],
    query,
  )
  assert.equal(tied.verdict, VERDICT.AMBIGUOUS)
  assert.equal(GATE[tied.verdict], 'inject', 'ambiguous 只说明分不出主次，不该被当成拒答')
  assert.equal(GATE[VERDICT.ABSTAIN], 'skip')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('abstain shadow pre-step tests passed (answer 注入 / abstain 不注入 / 契约一致)')
