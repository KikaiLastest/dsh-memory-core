import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { consolidate } from '../consolidate.mjs'

// 端到端：走真实的 apply / pre-step / recall / buildBlock / makeRecallMessage，
// 断言的是「模型最终收到的那条消息」，不是 recall() 的返回值。
// recall 层已经由 status.test.mjs 覆盖，这里只关心过滤之后有没有在组装阶段漏回去。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
const logFile = path.join(dir, 'recall.log')
const stateFile = path.join(dir, 'state.json')

// 四条都围绕「技术栈」，用来验证 topK 名额有没有被淘汰记录白占；
// 部署那条故意不含「技术栈」，确保无关记忆不被误伤。
const body = [
  '## 2026-10-20',
  '',
  '### 早期选型',
  '',
  '项目早期确定使用方案甲作为主力技术栈，团队熟悉并且生态成熟，这个决定当时已经落地执行。',
  '',
  '### 后来换掉了',
  '',
  '经过评估之后决定把技术栈整体换掉，新的选型更看重性能和维护成本，目前已经切换完成。',
  '',
  '### 部署环境',
  '',
  '部署环境固定在 Linux 服务器上运行，使用 systemd 管理进程，日志走 journalctl 收集。',
  '',
  '### 依赖管理',
  '',
  '技术栈的依赖版本统一锁在 lockfile 里，升级之前要先跑一遍完整测试再合并进主干。',
  '',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const oldPick = recs.find((r) => r.quote.includes('方案甲'))
const newPick = recs.find((r) => r.quote.includes('整体换掉'))
assert.ok(oldPick && newPick, '两条选型记录都在')

recs.find((r) => r.id === oldPick.id).status = 'superseded'
recs.find((r) => r.id === newPick.id).supersedes = oldPick.id
fs.writeFileSync(structuredFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

// ── 注册插件（mock 宿主） ────────────────────────────────────────
const handlers = []
const ctx = {
  inject: (deps, fn) => fn({ systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 } }),
  on: (ev, fn) => {
    if (ev === 'agent/pre-step') handlers.push(fn)
  },
  effect: (fn) => fn(),
}
apply(ctx, {
  memoryRoot,
  dialogueFile,
  structuredFile,
  stateFile,
  logFile,
  autocaptureStore: path.join(dir, 'cap.jsonl'),
  topK: 2, // 故意设小：淘汰记录若先占名额，有效结果就会不足
  minCoverage: 0.2,
  minMatched: 2,
  enableSummary: false,
  enableMemoryNav: false,
  enableAutoCapture: false,
})
assert.equal(handlers.length, 1, 'pre-step 钩子已注册')

async function run(text) {
  const payload = { step: 1, sessionId: 'inject-test' }
  const next = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })
  const r = await handlers[0](payload, next)
  const injected = (r.messages || []).find((m) => m && m.source && m.source.kind === 'memory-recall')
  const text2 = injected
    ? (Array.isArray(injected.content) ? injected.content : [])
        .filter((c) => c && c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    : ''
  return { r, injected, text: text2 }
}

// ── 1. 被取代的记忆绝不出现在最终注入里 ─────────────────────────
const tech = await run('技术栈')
assert.ok(tech.injected, '相关查询应当触发注入')
assert.ok(!tech.text.includes('方案甲'), '最终注入里不能出现已被取代的旧选型')
assert.ok(tech.text.includes('整体换掉'), '最终注入里应当包含当前有效的新选型')
assert.ok(tech.text.includes('以上为历史记录') || tech.text.includes('自动召回'), '注入块结构完整')

// ── 2. 过滤发生在 topK 截断之前：名额不给淘汰记录占 ──────────────
// 「技术栈」命中三条（旧选型 / 新选型 / 依赖管理），其中一条被淘汰。
// topK=2，正确实现应当还能给出 2 条有效记忆；先截断再过滤只会剩 1 条。
const hitCount = tech.text.split('\n').filter((l) => l.startsWith('[memory-recall] 来源：')).length
assert.equal(hitCount, 2, `topK 名额应当给有效记忆，实际注入 ${hitCount} 条`)

// ── 3. 无关记忆不受影响 ────────────────────────────────────────
const deploy = await run('部署环境')
assert.ok(deploy.injected, '部署查询应当注入')
assert.ok(deploy.text.includes('Linux'), '无关的有效记忆仍然能被召回')

// ── 4. 只有被淘汰的记忆匹配时，宁可不注入 ───────────────────────
const onlyOld = await run('方案甲')
const injectedOnlyOld = onlyOld.text.includes('方案甲')
assert.equal(injectedOnlyOld, false, '只匹配到淘汰记录时不应注入')

fs.rmSync(dir, { recursive: true, force: true })
console.log('injection tests passed')
process.exit(0)
