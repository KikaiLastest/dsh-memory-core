import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// 内容指纹去重：同一条查询第二次不该重复注入；记忆内容变了才重新注入。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-fp-'))
const memRoot = path.join(dir, 'memory')
fs.mkdirSync(memRoot, { recursive: true })
const entry = path.join(memRoot, '日记.md')
const writeEntry = (tail) =>
  fs.writeFileSync(entry, '# 日记\n\n- 2026-11-09 内容指纹去重验证：记录一条用于测试召回去重的记忆条目，关键词记忆核心测试。' + tail + '\n')
writeEntry('')

const handlers = []
const ctx = {
  inject: (deps, fn) => fn({ systemPrompt: { section: () => {}, getSectionOrder: () => 0 } }),
  on: (ev, fn) => { if (ev === 'agent/pre-step') handlers.push(fn) },
  effect: (fn) => fn(),
}
apply(ctx, {
  memoryRoot: memRoot,
  dialogueFile: path.join(dir, '对话记录.md'),
  stateFile: path.join(dir, 'state.json'),
  logFile: path.join(dir, 'recall.log'),
  activityFile: path.join(dir, 'activity.jsonl'),
  enableStable: false,
  enableMemoryNav: false,
  enableAutoCapture: false,
  enableSummary: false,
})
assert.equal(handlers.length, 1, 'pre-step 注册')

const run = async (text) => {
  const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] })
  return handlers[0]({ step: 1, sessionId: 'fp-test' }, next)
}

const query = '内容指纹去重验证'
const r1 = await run(query)
assert.equal(r1.messages.length, 2, '第一次注入')

const r2 = await run(query)
assert.equal(r2.messages.length, 1, '内容没变 -> 第二次去重')

writeEntry('补充一条不一样的内容。')
const r3 = await run(query)
assert.equal(r3.messages.length, 2, '内容变了 -> 重新注入')

const log = fs.readFileSync(path.join(dir, 'recall.log'), 'utf8')
assert.ok(log.includes('dedup'), '日志记了 dedup 原因')

fs.rmSync(dir, { recursive: true, force: true })
console.log('fingerprint dedup tests passed')
