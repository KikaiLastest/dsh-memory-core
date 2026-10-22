import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * 记忆状态与身份权威语义模块。
 * 召回（index.js）与常驻导航（summary.mjs）必须共用本模块，禁止各自实现状态查找与优先级判定。
 *
 * 身份契约定义：
 *   1. contentId: mem-{sha1(text).slice(0, 12)}
 *      内容哈希是记忆在跨生命周期、跨会话中的唯一稳定身份。
 *   2. sourceRef: "dialogue:{line}" 或 "diary:{line}"
 *      原文物理坐标，仅用于追溯，会随用户编辑产生位置漂移。
 *   3. representationId: 表现形式 ID
 *      - 原文条目: 继承 sourceRef（如 "dialogue:12"）
 *      - 摘要条目: "sum-{id}"
 *      - 捕获条目: "captured-{id}"
 */

/** 一条记忆的稳定内容身份：完整文本的 sha1 前缀。 */
export function idOf(text) {
  return 'mem-' + crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)
}

/**
 * 归一化提取小节标题指纹，用于长文本摘要去重（抗行号漂移）。
 */
export function titleFingerprint(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 解析任意记忆条目（原文小节、摘要或捕获项）在当前状态表中的权威状态。
 *
 * 优先级顺序严格固定：
 * 1. 显式内容身份 (entry.contentId)
 * 2. 文本内容哈希计算所得身份 (idOf(entry.text))
 * 3. 来源物理坐标 (entry.sourceId || entry.id)
 *
 * @param {Object} entry 记忆条目
 * @param {Object} statusMap loadStatusMap 返回的状态映射
 * @returns {string|null} 'active' | 'superseded' | 'archived' | 'draft' | null(未受状态管理)
 */
export function resolveEntryStatus(entry, statusMap) {
  if (!entry || !statusMap) return null
  const { byContentId, bySourceId } = statusMap

  // 1. 显式内容身份优先（例如摘要中记录的原文 content_id）
  if (entry.contentId && byContentId.has(entry.contentId)) {
    return byContentId.get(entry.contentId)
  }

  // 2. 原文内容完整哈希（原文条目）
  if (entry.text) {
    const cid = idOf(entry.text)
    if (byContentId.has(cid)) {
      return byContentId.get(cid)
    }
  }

  // 3. 来源位置匹配（辅助兜底：行号命中且未被内容哈希覆盖）
  const src = entry.sourceId || entry.id
  if (src && bySourceId.has(src)) {
    return bySourceId.get(src)
  }

  return null
}

/**
 * 状态有效性判定。
 *
 * @param {string|null} status 状态值
 * @param {Object} [options]
 * @param {boolean} [options.degraded=false] 状态表是否处于损坏或无法读取的降级状态
 * @param {boolean} [options.conservative=true] 降级时是否采取保守防御策略
 * @returns {boolean} 是否允许召回/注入
 */
export function isRecallable(status, options = {}) {
  const { degraded = false, conservative = false } = options

  // 显式废弃/归档/草稿，任何时候坚决不可召回
  if (status && status !== 'active') {
    return false
  }

  // 显式标明 active
  if (status === 'active') {
    return true
  }

  // status 为 null/undefined 表示该记忆未记录在 structured.jsonl 中
  // 在状态表正常或首次运行时，按向后兼容策略放行
  if (!degraded) {
    return true
  }

  // 状态表损坏或不可读（degraded）：
  // 若启用保守策略，未知条目视为不可信，防止被取代的历史旧决策在状态表损坏时整体复活
  return !conservative
}

/**
 * 统一多通道候选过滤管道。
 * 供 index.js 候选池加载与 summary.mjs 常驻导航共用。
 *
 * @param {Array<Object>} entries 候选条目列表
 * @param {Object} statusMap loadStatusMap 返回的状态元数据
 * @param {Object} [options]
 * @param {boolean} [options.conservative=false] 降级时是否保守过滤
 * @returns {{ recallable: Array<Object>, suppressed: number, unverified: number, idDrift: number }}
 */
export function filterRecallableEntries(entries, statusMap, options = {}) {
  const recallable = []
  let suppressed = 0
  let unverified = 0
  let idDrift = 0

  const degraded = Boolean(statusMap && statusMap.degraded)
  const conservative = Boolean(options.conservative)

  for (const entry of entries) {
    const status = resolveEntryStatus(entry, statusMap)

    // 探测行号漂移：内容哈希没中，但物理行号撞上了其他记录
    if (status === null && entry.id && statusMap.bySourceId && statusMap.bySourceId.has(entry.id)) {
      idDrift += 1
    }

    if (!isRecallable(status, { degraded, conservative })) {
      if (status && status !== 'active') {
        suppressed += 1
      } else {
        unverified += 1
      }
      continue
    }

    recallable.push(entry)
  }

  return { recallable, suppressed, unverified, idDrift }
}

/**
 * 读固化产物的状态表。
 * 建立双向索引并输出明确的健康诊断状态。
 *
 * @param {Object} cfg 配置对象，需包含 structuredFile
 * @returns {{
 *   bySourceId: Map<string, string>,
 *   byContentId: Map<string, string>,
 *   degraded: boolean,
 *   reason: 'ok' | 'missing' | 'unreadable' | 'corrupt' | 'not_configured',
 *   totalRecords: number,
 *   brokenLines: number
 * }}
 */
export function loadStatusMap(cfg = {}) {
  const bySourceId = new Map()
  const byContentId = new Map()
  const file = cfg.structuredFile

  if (!file) {
    return {
      bySourceId,
      byContentId,
      degraded: false,
      reason: 'not_configured',
      totalRecords: 0,
      brokenLines: 0,
    }
  }

  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const missing = err && err.code === 'ENOENT'
    return {
      bySourceId,
      byContentId,
      degraded: !missing,
      reason: missing ? 'missing' : 'unreadable',
      totalRecords: 0,
      brokenLines: 0,
    }
  }

  if (!text.trim()) {
    return {
      bySourceId,
      byContentId,
      degraded: false,
      reason: 'missing',
      totalRecords: 0,
      brokenLines: 0,
    }
  }

  const byMemId = new Map()
  const records = []
  let brokenLines = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      brokenLines += 1
      continue
    }
    if (!rec || !rec.source_id) continue
    const status = typeof rec.status === 'string' ? rec.status : null
    records.push({ rec, status })
    byMemId.set(rec.id, rec)
    bySourceId.set(rec.source_id, status)
    if (rec.id) byContentId.set(rec.id, status)
  }

  // 关系链覆盖：无论记录本身标什么，只要被任何记录 supersedes 指向，强制置为 superseded
  for (const { rec } of records) {
    if (!rec.supersedes) continue
    const target = byMemId.get(rec.supersedes)
    if (!target) continue
    if (target.source_id) bySourceId.set(target.source_id, 'superseded')
    if (target.id) byContentId.set(target.id, 'superseded')
  }

  const degraded = records.length === 0 && brokenLines > 0
  return {
    bySourceId,
    byContentId,
    degraded,
    reason: degraded ? 'corrupt' : 'ok',
    totalRecords: records.length,
    brokenLines,
  }
}
