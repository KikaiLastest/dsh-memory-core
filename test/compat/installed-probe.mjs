import path from 'node:path'
import * as pkg from 'dsh-memory-core'

/**
 * 安装产物探针：只在 consumer 项目里跑（由 data-isolation.test.mjs 复制进去）。
 *
 * 它按**包名**导入，走的是 npm 的包解析和 exports 字段 —— 也就是用户真实遇到的那一层。
 * 两种模式：
 *   configured —— 指向临时档案，跑真实召回 + 注入，验证功能可用；
 *   defaults   —— 不给任何路径，验证默认落点（DSH_HOME）不在安装目录里。
 * 结果打成一行 RESULT:<json> 给测试解析。
 */

const mode = process.env.PROBE_MODE || 'configured'
const sections = []
const handlers = []
const ctx = {
  inject: (deps, fn) => fn({ systemPrompt: { section: (s) => { sections.push(s.name); return () => {} } } }),
  on: (event, fn) => { if (event === 'agent/pre-step') handlers.push(fn) },
  effect: (fn) => fn(),
}

const dataDir = process.env.PROBE_DATA || ''
const cfg = mode === 'defaults' ? {} : {
  memoryRoot: process.env.PROBE_MEMORY,
  dialogueFile: process.env.PROBE_DIALOGUE,
  structuredFile: path.join(dataDir, '记忆', 'structured.jsonl'),
  logFile: path.join(dataDir, 'recall.log'),
  stateFile: path.join(dataDir, 'affect', 'state.json'),
  autocaptureStore: path.join(dataDir, 'cap', 'captures.jsonl'),
  summaryStore: path.join(dataDir, 'cap', 'summaries.jsonl'),
  enableSummary: false,
  enableMemoryNav: false,
  enableAutoCapture: false,
}

pkg.apply(ctx, cfg)

// 直接调用导出的 recall 需要完整 cfg（memoryRoot / dialogueFile）。
// defaults 模式故意不给路径，所以只走宿主的 pre-step 路径（它用的是 apply 内部的归一化配置）。
// 这条边界本身是已知限制：recall({}, q) 会抛 ERR_INVALID_ARG_TYPE，见报告。
const directRecallEnabled = mode !== 'defaults'
let hits = []
let directRecallError = null
if (directRecallEnabled) {
  try {
    hits = pkg.recall(cfg, '阿尔法项目数据库', Date.now() + 2000)
  } catch (error) {
    directRecallError = String((error && error.message) || error)
  }
}
const decision = await handlers[0](
  { step: 1, sessionId: 'iso' },
  async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: '阿尔法项目数据库用的是什么', source: { kind: 'user' } }],
  }),
)
const messages = (decision && decision.messages) || []
const injected = messages.filter((m) => m && m.source && m.source.kind === 'memory-recall').length
const contractOk = hits.every(
  (h) =>
    typeof h.score === 'number' &&
    typeof h.coverage === 'number' &&
    typeof h.weight === 'number' &&
    Math.abs(h.preDecayScore - (h.queryScore + h.effectiveExpansionScore)) < 1e-9,
)

console.log(
  'RESULT:' +
    JSON.stringify({
      mode,
      hits: hits.length,
      directRecallError,
      ids: hits.map((h) => h.entry.id),
      contractOk,
      injected,
      sections: sections.length,
      hadDecision: !!decision,
    }),
)
