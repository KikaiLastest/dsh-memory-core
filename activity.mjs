/**
 * 工具动作采集 —— 只记「谁在什么时候动了哪个文件」，不记任何内容。
 *
 * 为什么要它：并行开子代理时，两个会话改同一个文件会互相覆盖，而且事后谁也说不清
 * 是谁先动的。这里只落元数据（工具名、路径、目录、参数摘要哈希），可以用来判撞车。
 *
 * 隐私红线：
 *  · 落库字段只有 ts / session 哈希 / tool / path / dir / argsDigest；
 *  · argsDigest 的输入只有工具名、路径、参数长度这类元数据，**不含内容片段**；
 *  · 原始命令、写入内容、老字符串一律不落盘、不进日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 会改文件的工具名。别的工具（读、搜、查）不记，免得日志全是噪声。 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_skill', 'present'])

/** 会话 ID 只留哈希，避免把宿主里的 session 标识原样写盘。 */
export function sessionTag(session) {
  const s = String(session || 'unknown')
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10)
}

/** 摘要只吃元数据：工具名、路径、参数键数、参数字符串总长。 */
export function argsDigest(tool, args) {
  let keys = 0
  let len = 0
  try {
    if (args && typeof args === 'object') {
      keys = Object.keys(args).length
      for (const v of Object.values(args)) len += typeof v === 'string' ? v.length : 0
    }
  } catch {
    /* 拿不到就当空 */
  }
  return crypto.createHash('sha1').update(`${tool}|${keys}|${len}`).digest('hex').slice(0, 16)
}

/** 从各种宿主 payload 形状里掏出工具名/参数/会话，掏不到就返回 null。 */
export function normalizeToolEvent(payload) {
  if (!payload || typeof payload !== 'object') return null
  const call = payload.call || payload.toolCall || payload.tool_call || null
  const tool =
    (typeof payload.tool === 'string' && payload.tool) ||
    (payload.tool && payload.tool.name) ||
    payload.toolName ||
    payload.name ||
    (call && call.name) ||
    null
  const args = payload.args || payload.arguments || payload.input || (call && (call.args || call.arguments)) || null
  const session =
    payload.sessionId || payload.sessionID || payload.session || payload.agentId || payload.agent_id || 'unknown'
  if (!tool) return null
  return { tool: String(tool), args, session: typeof session === 'string' ? session : 'unknown' }
}

/** 从参数里挑目标路径。只认明确的文件路径字段，不猜。 */
export function targetPath(args) {
  if (!args || typeof args !== 'object') return ''
  for (const k of ['file_path', 'filePath', 'path', 'target', 'file', 'outputPath']) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

export function recordPathOf(p) {
  if (!p) return ''
  try {
    return path.resolve(p)
  } catch {
    return p
  }
}

/** 读最近 windowMs 内的记录，最多回看 800 行（文件再长也不整读）。 */
export function readRecent(file, windowMs, now = Date.now()) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.trim().split('\n').slice(-800)
  const out = []
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      if (r && typeof r.ts === 'number' && now - r.ts <= windowMs) out.push(r)
    } catch {
      /* 坏行跳过，不因此中断采集 */
    }
  }
  return out
}

/**
 * 记一条动作；顺手算撞车（同路径、不同会话、在窗口内）。
 * @returns {{path:string, collisions:Array<{session:string, ts:number}>}|null}
 */
export function recordActivity({ file, session, tool, args, windowMs = 30 * 60 * 1000, now = Date.now() }) {
  const toolName = String(tool || '')
  if (!WRITE_TOOLS.has(toolName)) return null
  const p = targetPath(args)
  if (!p) return null
  const abs = recordPathOf(p)
  const rec = {
    ts: now,
    session: sessionTag(session),
    tool: toolName,
    path: abs,
    dir: recordPathOf(path.dirname(abs)),
    argsDigest: argsDigest(toolName, args),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  } catch {
    /* 采集失败不该影响工具执行 */
  }
  const collisions = readRecent(file, windowMs, now).filter(
    (r) => r.path === abs && r.session !== rec.session,
  )
  return { path: abs, collisions }
}
