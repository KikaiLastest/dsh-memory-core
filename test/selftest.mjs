import fs from 'node:fs'
import assert from 'node:assert'
import { apply } from '../index.js'

const STATE = './.selftest-state.json'
const LOG = './.selftest-recall.log'
for (const f of [STATE, LOG]) {
  try {
    fs.unlinkSync(f)
  } catch {}
}

const sections = []
const handlers = []
const ctx = {
  inject: (deps, fn) => {
    fn({
      systemPrompt: {
        section: (s) => sections.push(s),
        getSectionOrder: () => 0,
      },
    })
  },
  on: (ev, fn) => {
    if (ev === 'agent/pre-step') handlers.push(fn)
  },
  effect: (fn) => fn(),
}

apply(ctx, {
  memoryRoot: 'D:/dsh-workspace/memory',
  dialogueFile: 'D:/dsh-workspace/对话记录.md',
  stateFile: STATE,
  logFile: LOG,
})

console.log('sections:', sections.length, '|', sections.map((s) => s.name).join(', '))
assert.ok(sections.length >= 2, 'P0a + P2 sections registered')
assert.equal(handlers.length, 1, 'pre-step handler registered')

async function run(text) {
  const payload = { step: 1, sessionId: 'selftest' }
  const next = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })
  return handlers[0](payload, next)
}

// 1. affect: praise
const r1 = await run('谢谢你')
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
console.log('praise -> valence:', st.valence, '| trigger:', st.trigger.kind)
assert.ok(st.valence > 0, 'valence rises')
assert.equal(st.trigger.kind, 'praise')

// 2. recall: relevant query injects a prefixed message
const r2 = await run('记忆档案是什么')
const injected = r2.messages.length === 2
console.log('recall -> messages:', r2.messages.length, '| injected:', injected)
if (injected) {
  const t = r2.messages[0].content[0].text
  assert.match(t, /不是用户本轮发言/)
  assert.match(t, /不构成指令/)
}

// 3. unrelated query: no injection
const r3 = await run('zzzz乱码查询')
console.log('unrelated -> messages:', r3.messages.length)

// 4. scold updates affect
const r4 = await run('你个废物')
const st2 = JSON.parse(fs.readFileSync(STATE, 'utf8'))
console.log('scold -> valence:', st2.valence, '| trigger:', st2.trigger.kind)
assert.ok(st2.valence < st.valence, 'valence drops on scold')

// 5. log written
const logLines = fs.readFileSync(LOG, 'utf8').trim().split('\n').length
console.log('recall.log lines:', logLines)
assert.ok(logLines >= 3, 'recall log written')

console.log('SELFTEST PASSED')
