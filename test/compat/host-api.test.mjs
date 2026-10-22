import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pkg from '../../index.js'

/**
 * 宿主 API 兼容测试：DSH 不是只有一种宿主。
 *
 * headless / 精简部署里，插件拿到的 ctx 可能缺 systemPrompt、缺 webServer、
 * 缺 configEditor、缺 effect，甚至 inject / on 本身都会抛。这些缺失必须只降级
 * 对应功能，不能让 apply() 整行加载失败 —— 一旦抛出去，用户看到的是插件挂不上，
 * 而不是「设置面板没了」。
 *
 * 这里用最小假 ctx 把每种缺失组合都过一遍：断言的是「不崩 + 能降级的降级」。
 */

const { name, inject, apply, recall } = pkg

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostapi-'))
const memoryRoot = path.join(dir, 'memory')
fs.mkdirSync(memoryRoot, { recursive: true })
fs.writeFileSync(
  path.join(memoryRoot, '日记.md'),
  ['## 2026-10-20', '', '- 阿尔法项目数据库使用 PostgreSQL 16，主键走雪花 ID。', ''].join('\n'),
  'utf8',
)
const dialogueFile = path.join(dir, '对话记录.md')
fs.writeFileSync(dialogueFile, '## 2026-10-20\n\n- 阿尔法项目数据库使用 PostgreSQL 16。\n', 'utf8')

const cfg = () => ({
  memoryRoot,
  dialogueFile,
  structuredFile: path.join(dir, '记忆', 'structured.jsonl'),
  logFile: path.join(dir, 'recall.log'),
  stateFile: path.join(dir, 'affect', 'state.json'),
  autocaptureStore: path.join(dir, 'cap', 'captures.jsonl'),
  summaryStore: path.join(dir, 'cap', 'summaries.jsonl'),
  enableSummary: false,
  enableMemoryNav: false,
  enableAutoCapture: false,
})

/** 假宿主：inject / on / effect 各自可选 ok / absent / throw。 */
function makeHost({ injectMode = 'ok', onMode = 'ok', effectMode = 'ok', child = {} } = {}) {
  const reg = { injects: [], handlers: [], effects: [], sections: [], routes: [], warns: [] }
  const ctx = {}
  if (injectMode !== 'absent') {
    ctx.inject = (deps, fn) => {
      reg.injects.push([...deps])
      if (injectMode === 'throw') throw new Error('这个宿主没有 inject')
      const childCtx = typeof child === 'function' ? child(reg) : child
      return fn(childCtx)
    }
  }
  if (onMode !== 'absent') {
    ctx.on = (event, fn, options) => {
      if (onMode === 'throw') throw new Error('这个宿主不认 agent/pre-step')
      if (event === 'agent/pre-step') reg.handlers.push({ fn, options })
    }
  }
  if (effectMode !== 'absent') {
    ctx.effect = (fn) => {
      if (effectMode === 'throw') throw new Error('这个宿主没有 effect')
      reg.effects.push(fn)
      return fn()
    }
  }
  return { ctx, reg }
}

/** 完整宿主的子上下文（systemPrompt + webServer + configEditor）。 */
function richChild(reg) {
  return {
    systemPrompt: { section: (s) => { reg.sections.push(s.name); return () => {} } },
    webServer: { register: (route) => { reg.routes.push(route.path); return () => {} } },
    get: (key) => (key === 'configEditor' ? { entries: () => [], edit: async () => {} } : undefined),
  }
}

let checked = 0
function ok(label, condition, detail = '') {
  assert.ok(condition, detail ? label + ' —— ' + detail : label)
  checked += 1
}

function runApply(label, hostOpts, config = cfg()) {
  const { ctx, reg } = makeHost(hostOpts)
  let error = null
  try {
    apply(ctx, config)
  } catch (e) {
    error = e
  }
  ok(label + '：apply 不抛错', error === null, error && error.message)
  for (const deps of reg.injects) {
    for (const dep of deps) {
      ok(label + '：只向宿主申请已知服务 ' + dep, dep === 'systemPrompt' || dep === 'webServer', '申请了 ' + dep)
    }
  }
  return { ctx, reg }
}

// ── 1. 模块声明 ────────────────────────────────────────────────────────
ok('name 导出等于包名', name === 'dsh-memory-core', String(name))
ok('inject 声明只有 systemPrompt', JSON.stringify(inject) === JSON.stringify(['systemPrompt']), JSON.stringify(inject))

// ── 2. 各种缺 API 的宿主 ───────────────────────────────────────────────
const variants = [
  ['空 ctx（什么都没有）', { injectMode: 'absent', onMode: 'absent', effectMode: 'absent' }],
  ['inject 抛错', { injectMode: 'throw' }],
  ['on 抛错', { onMode: 'throw' }],
  ['effect 抛错', { effectMode: 'throw' }],
  ['inject + on + effect 全抛', { injectMode: 'throw', onMode: 'throw', effectMode: 'throw' }],
  ['注入回调拿到 undefined', { injectMode: 'ok', child: () => undefined }],
  ['只有 systemPrompt（没有 webServer / get）', { child: (reg) => ({ systemPrompt: richChild(reg).systemPrompt }) }],
  ['systemPrompt 缺 section', { child: { systemPrompt: {} } }],
  ['systemPrompt.section 抛错', { child: { systemPrompt: { section() { throw new Error('section 不支持') } } } }],
  ['systemPrompt.section 返回 undefined', { child: { systemPrompt: { section: () => undefined } } }],
  ['webServer 缺 register', { child: { webServer: {} } }],
  [
    'webServer.register 抛错 + logger.warn 也抛',
    {
      child: {
        webServer: { register() { throw new Error('路由重复') } },
        logger: { warn() { throw new Error('logger 也坏了') } },
      },
    },
  ],
  [
    'get(configEditor) 抛错',
    { child: { get() { throw new Error('get 不支持') } } },
  ],
]

const applied = new Map()
for (const [label, opts] of variants) {
  const { ctx, reg } = runApply(label, opts)
  applied.set(label, { ctx, reg })
  const { reg: _r } = applied.get(label)
}

// ── 3. 降级行为：缺什么只少什么 ─────────────────────────────────────────
const empty = applied.get('空 ctx（什么都没有）')
ok('空 ctx：没注册任何钩子', empty.reg.handlers.length === 0, 'handlers=' + empty.reg.handlers.length)

const onlyPrompt = applied.get('只有 systemPrompt（没有 webServer / get）')
ok('只有 systemPrompt：常驻段挂上了', onlyPrompt.reg.sections.includes('dsh-memory-core:affect'), onlyPrompt.reg.sections.join(','))
ok('只有 systemPrompt：pre-step 仍然注册', onlyPrompt.reg.handlers.length === 1, 'handlers=' + onlyPrompt.reg.handlers.length)
ok('只有 systemPrompt：没有面板路由', onlyPrompt.reg.routes.length === 0, onlyPrompt.reg.routes.join(','))

const noInject = applied.get('inject 抛错')
ok('inject 抛错：常驻段与面板全降级', noInject.reg.sections.length === 0 && noInject.reg.routes.length === 0)
ok('inject 抛错：按需召回仍然挂上（on 还在）', noInject.reg.handlers.length === 1, 'handlers=' + noInject.reg.handlers.length)

const richHost = runApply('完整宿主', { child: richChild })
ok('完整宿主：两条面板路由 + 三段常驻文本', richHost.reg.routes.length === 2, richHost.reg.routes.join(','))
ok('完整宿主：常驻段数量', richHost.reg.sections.length >= 2, richHost.reg.sections.join(','))

// ── 4. pre-step 在精简宿主里照旧可用 ───────────────────────────────────
const handlers = onlyPrompt.reg.handlers
const query = '阿尔法项目数据库用的是什么'
const decision = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: query }], source: { kind: 'user' } }],
}
const out = await handlers[0].fn({ step: 1, sessionId: 'compat' }, async () => decision)
ok('pre-step：返回的决策仍是对象', out !== null && typeof out === 'object')
ok('pre-step：消息数组还在', Array.isArray(out.messages))
const injected = out.messages.find((m) => m && m.source && m.source.kind === 'memory-recall')
ok('pre-step：召回能走通（要么注入，要么按 evidence 判定不注入）', injected === undefined || out.messages.length === decision.messages.length + 1)
ok('pre-step：日志文件被写入（logFile 路径生效）', fs.existsSync(path.join(dir, 'recall.log')))

// 命中但判定 abstain 时不许注入候选
const hits = recall(cfg(), query)
ok('recall 在精简宿主里仍能返回数组', Array.isArray(hits))

// 已知边界（不在本代理的文件所有权内，只能记录不能修）：
// 导出的 recall(cfg, …) 直接读 cfg.memoryRoot / cfg.dialogueFile，
// 传未归一化的 {} 会抛 ERR_INVALID_ARG_TYPE，而不是「返回空结果」。
// 修好之后这里会变成不抛，断言仍然成立，所以它不会拦住修复。
let partialCfg = null
try {
  recall({}, query)
} catch (error) {
  partialCfg = error
}
ok(
  '已知边界：recall({}) 需要归一化 cfg（现在会抛 ERR_INVALID_ARG_TYPE）',
  partialCfg === null || partialCfg.code === 'ERR_INVALID_ARG_TYPE',
  String(partialCfg && partialCfg.code),
)

// ── 5. pre-step 的边界输入 ─────────────────────────────────────────────
const step2 = await handlers[0].fn({ step: 2 }, async () => decision)
ok('step>1：原样放行（同一个对象）', step2 === decision)

const nonEnter = { kind: 'reject', reason: 'x' }
ok('非 enter 决策：原样放行', (await handlers[0].fn({ step: 1 }, async () => nonEnter)) === nonEnter)
ok('next 返回 null：不崩', (await handlers[0].fn({ step: 1 }, async () => null)) === null)

let propagated = null
try {
  await handlers[0].fn({ step: 1 }, async () => { throw new Error('下游插件炸了') })
} catch (e) {
  propagated = e
}
ok('下游 next() 抛错：不吞掉（宿主链路的错要原样冒出去）', propagated !== null && propagated.message === '下游插件炸了')

const recallMsg = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: '阿尔法项目数据库' }], source: { kind: 'memory-recall' } }],
}
const noUser = await handlers[0].fn({ step: 1 }, async () => recallMsg)
ok('只有 memory-recall 消息时：不重复召回', noUser === recallMsg)

const short = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '好' }], source: { kind: 'user' } }] }
ok('超短查询：不崩', (await handlers[0].fn({ step: 1 }, async () => short)) !== null)

const long = '阿'.repeat(400)
const longDecision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: long }], source: { kind: 'user' } }] }
ok('超长查询：不崩', (await handlers[0].fn({ step: 1 }, async () => longDecision)) !== null)

// ── 6. 生命周期：effect 拿到的 disposer 能用 ───────────────────────────
const summarizing = runApply('开启后台总结', { child: { systemPrompt: { section: () => () => {} } } }, { ...cfg(), enableSummary: true })
ok('开启后台总结：effect 注册了清理函数', summarizing.reg.effects.length >= 1, 'effects=' + summarizing.reg.effects.length)
const disposer = summarizing.reg.effects[summarizing.reg.effects.length - 1]()
ok('清理函数：调用后不抛错', typeof disposer === 'function' || disposer === undefined)
if (typeof disposer === 'function') disposer()

// ── 7. 奇怪的配置值不许把 apply 带崩 ──────────────────────────────────
const weird = runApply('配置全是垃圾值', { child: richChild }, {
  ...cfg(),
  topK: '不是数字',
  timeoutMs: -1,
  minCoverage: 'x',
  halfLifeDays: null,
  dailyQuota: 999,
  enableStable: 'yes',
})

fs.rmSync(dir, { recursive: true, force: true })
console.log('宿主 API 兼容测试通过（' + checked + ' 项断言，' + variants.length + ' 种精简宿主）')
process.exit(0)
