import { sections } from '../consolidate.mjs'
import { idOf } from '../status.mjs'

/**
 * 污染判定器：按「条目身份」而不是「返回文本里有没有禁用子串」判污染。
 *
 * 为什么要单独一层：
 * - 旧口径（eval-report.mjs 以前的写法）只看返回文本 includes(forbid)。
 *   新条目正文里引用旧词（「换成 MySQL 8 … PostgreSQL 那套迁移脚本已经改写完成」）
 *   会被判成污染，而真正被淘汰的旧条目换个说法泄漏反而测不出来。
 * - 这里把判定拆成两步：
 *     1) 标注阶段：用冻结语料 + 固化记录，静态算出「哪条记录承载了哪个 forbid 声明」、
 *        「哪条记录是这条查询的期望答案」；
 *     2) 判定阶段：只看召回返回的 entry.sourceId / contentId / 内容哈希，
 *        身份命中承载者且不是期望答案，才算内容污染；
 *        身份状态是 superseded/archived，才算过期身份泄漏。
 *   第 1 步用子串只是「把标签映射到条目」，不会因为某条正确条目的正文提到旧词就把它判成污染。
 *
 * 冻结语料没有 per-case 的 forbid_ids 标注，所以承载者是从语料小节里可复现地构造出来的；
 * 这层构造规则写在 describe().construction 里，报告会原样带出。
 */

export const DEFAULT_STALE_STATUSES = Object.freeze(['superseded', 'archived'])

const asArray = (v) => (Array.isArray(v) ? v : [])

function sectionTitle(text) {
  return (text.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
}

/**
 * @param {object} opts
 * @param {string} opts.dialogueText 冻结语料原文（与传给 consolidate 的完全同一份）
 * @param {object[]} opts.records structured.jsonl 解析后的记录（含 source_id / id / status / quote）
 * @param {string[]} [opts.staleStatuses] 哪些状态算「已淘汰」
 */
export function createPollutionOracle({ dialogueText, records, staleStatuses = DEFAULT_STALE_STATUSES } = {}) {
  if (typeof dialogueText !== 'string') throw new TypeError('createPollutionOracle: dialogueText 必须是字符串')
  if (!Array.isArray(records)) throw new TypeError('createPollutionOracle: records 必须是数组')

  const stale = [...staleStatuses]
  const problems = []
  const items = sections(dialogueText).map((s) => ({
    sourceId: 'dialogue:' + s.line,
    contentId: idOf(s.text),
    text: s.text,
    fact: sectionTitle(s.text),
    status: 'unknown', // 语料里有、状态表里没有：不冒充 active，也不判泄漏
    recorded: false,
  }))

  const bySource = new Map()
  const byContent = new Map()
  for (const item of items) {
    if (bySource.has(item.sourceId)) problems.push('重复的 sourceId: ' + item.sourceId)
    if (byContent.has(item.contentId)) {
      problems.push('内容哈希冲突: ' + item.contentId + '（两段正文完全相同，身份无法区分）')
    }
    bySource.set(item.sourceId, item)
    byContent.set(item.contentId, item)
  }

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') {
      problems.push('结构化记录不是对象，已跳过')
      continue
    }
    const sourceId = typeof rec.source_id === 'string' && rec.source_id ? rec.source_id : null
    const contentId = typeof rec.id === 'string' && rec.id ? rec.id : null
    let item = (sourceId && bySource.get(sourceId)) || (contentId && byContent.get(contentId)) || null

    if (!item) {
      // 独立捕获/摘要记录没有对应语料小节：用 quote 造一个只读条目。
      // 只用于身份判定，不会被当成召回候选。
      const text = typeof rec.quote === 'string' ? rec.quote : ''
      if (!text) {
        problems.push('记录 ' + (sourceId || contentId || '(无身份)') + ' 既无对应小节也无 quote，无法参与判定')
        continue
      }
      item = {
        sourceId: sourceId || 'record:' + (contentId || idOf(text)),
        contentId: contentId || idOf(text),
        text,
        fact: typeof rec.fact === 'string' ? rec.fact : sectionTitle(text),
        status: 'unknown',
        recorded: false,
      }
      items.push(item)
      if (!bySource.has(item.sourceId)) bySource.set(item.sourceId, item)
      if (!byContent.has(item.contentId)) byContent.set(item.contentId, item)
    }

    // 行号口径必须和 consolidate.sections 完全一致；quote 是原文前 200 字的切片，
    // 对不上说明语料/固化记录漂了。继续按内容哈希兜底，但留一条 problem，
    // 别让身份判定静默错位。
    if (sourceId && /^dialogue:\d+$/.test(sourceId)) {
      if (typeof rec.quote === 'string' && rec.quote && !item.text.startsWith(rec.quote)) {
        problems.push('记录 ' + sourceId + ' 的 quote 不是语料小节前缀（行号或正文漂移）')
      }
    }

    const rawStatus = rec.status === undefined || rec.status === null ? 'active' : String(rec.status)
    item.status = rawStatus
    item.recorded = true
    if (typeof rec.fact === 'string' && rec.fact) item.fact = rec.fact
  }

  const termCache = new Map()
  /** 文本命中哪些条目的身份（sourceId + contentId 都放进去，行号漂了也能按内容对齐）。 */
  function keysForText(text) {
    if (termCache.has(text)) return termCache.get(text)
    const keys = new Set()
    for (const item of items) {
      if (item.text.includes(text)) {
        keys.add(item.sourceId)
        keys.add(item.contentId)
      }
    }
    termCache.set(text, keys)
    return keys
  }

  const empty = new Set()

  return {
    staleStatuses: stale,

    /** 返回结果可能带多个身份：显式 contentId、正文内容哈希、sourceId、条目 id。 */
    keysOf(hit) {
      const e = hit && typeof hit === 'object' && hit.entry ? hit.entry : hit || {}
      const keys = []
      const push = (v) => {
        if (typeof v === 'string' && v && !keys.includes(v)) keys.push(v)
      }
      push(e.contentId)
      if (typeof e.text === 'string' && e.text) push(idOf(e.text))
      push(e.sourceId)
      push(e.id)
      return keys
    },

    /** 给人看的身份：优先来源位置，其次条目 id，最后内容哈希。 */
    labelOf(hit) {
      const e = hit && typeof hit === 'object' && hit.entry ? hit.entry : hit || {}
      return e.sourceId || e.id || e.contentId || null
    },

    /** 身份状态解析：非 active 优先（与 status.mjs 的「blocked 优先」一致）。 */
    statusOf(keys) {
      let active = null
      for (const key of asArray(keys)) {
        const item = byContent.get(key) || bySource.get(key)
        if (!item || item.status === 'unknown') continue
        if (item.status !== 'active') return item.status
        active = 'active'
      }
      return active === null ? 'unknown' : active
    },

    /** 这条查询的期望答案对应的条目身份。 */
    expectedKeysOf(c) {
      if (!c || c.expect === null || typeof c.expect !== 'string') return empty
      return keysForText(c.expect)
    },

    /** 承载 forbid 声明的条目身份（按语料小节构造，per-case 标注缺失时的可复现替代）。 */
    carrierKeysOf(c) {
      const keys = new Set()
      for (const term of asArray(c && c.forbid)) {
        for (const k of keysForText(term)) keys.add(k)
      }
      return keys
    },

    describe() {
      const statusCounts = {}
      for (const item of items) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1
      return {
        strategy: 'identity-first',
        construction:
          '用冻结语料小节 + structured.jsonl 记录构造：forbid/expect 子串只在语料里定位承载条目，' +
          '最终判定看返回条目的 sourceId/contentId/内容哈希；期望答案自身引用旧词不算内容污染。',
        staleStatuses: stale,
        sections: items.length,
        recorded: items.filter((i) => i.recorded).length,
        statusCounts,
        staleIds: items.filter((i) => stale.includes(i.status)).map((i) => i.sourceId + '(' + i.status + ')'),
        problems,
      }
    },
  }
}
