import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * 记忆状态语义 —— 召回和常驻导航共用这一份，避免两条路径各判各的。
 *
 * 身份分两种，职责不能混：
 *   id       完整内容的哈希，记忆的稳定身份（内容变了就是另一条记忆）
 *   source_id 原文位置（"dialogue:行号"），只用于追溯，会随文件编辑漂移
 */

/** 一条记忆的稳定身份：完整内容的 sha1 前缀。 */
export function idOf(text) {
  return 'mem-' + crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)
}

/**
 * 当前有效性判定。只看 status，不认识来源和分数。
 * null / undefined 表示「没标过状态」的旧记录，按兼容策略保留。
 */
export function isRecallable(status) {
  if (status === null || status === undefined) return true
  return status === 'active'
}

/**
 * 读固化产物的状态表。
 *
 * 关系优先于状态字段：一条记录自己写着 active，只要被别的记录 supersedes 指到，就算已取代。
 * 手动改状态时漏掉一半，是这类系统最常见的坏数据。
 *
 * 返回两张表：
 *   byContentId  rec.id -> status      主键，内容身份，抗行号漂移
 *   bySourceId   source_id -> status   辅助，只用于发现「这条被编辑过」
 *
 * 另外返回 degraded / reason，用来区分三件完全不同的事：
 *   missing    还没固化过，空表是正常状态
 *   unreadable 文件在但读不出来（权限、锁、路径错）
 *   corrupt    读到了但一行都解析不出来
 * 后两种等于「我不知道这条记忆有没有被淘汰」。按兼容策略全放行的话，
 * 被标成 superseded 的旧决策会整体回到上下文里。调用方至少要知道自己在降级运行。
 */
export function loadStatusMap(cfg = {}) {
  const bySourceId = new Map()
  const byContentId = new Map()
  const file = cfg.structuredFile
  if (!file) return { bySourceId, byContentId, degraded: false, reason: 'not_configured' }

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
    }
  }
  if (!text) return { bySourceId, byContentId, degraded: false, reason: 'missing' }

  const byMemId = new Map()
  const records = []
  let brokenLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      brokenLines += 1 // 单行损坏不该让整张状态表失效
      continue
    }
    if (!rec || !rec.source_id) continue
    const status = typeof rec.status === 'string' ? rec.status : null
    records.push({ rec, status })
    byMemId.set(rec.id, rec)
    bySourceId.set(rec.source_id, status)
    if (rec.id) byContentId.set(rec.id, status)
  }

  // 第二遍才有完整 byMemId，supersedes 可能指向后面才出现的记录
  for (const { rec } of records) {
    if (!rec.supersedes) continue
    const target = byMemId.get(rec.supersedes)
    if (!target) continue
    if (target.source_id) bySourceId.set(target.source_id, 'superseded')
    if (target.id) byContentId.set(target.id, 'superseded')
  }
  // 一行都没读出来、却确实有坏行：这是整张表废了，不是「恰好没有记录」
  const degraded = records.length === 0 && brokenLines > 0
  return {
    bySourceId,
    byContentId,
    degraded,
    reason: degraded ? 'corrupt' : 'ok',
  }
}
