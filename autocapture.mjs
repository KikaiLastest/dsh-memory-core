import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { sanitize } from './sanitize.mjs'

/**
 * 筛选重要/值得保留的对话启发式规则。
 * 避免通用闲聊或单字寒暄，只捕获含事实、约定、偏好、重要排障、配置或用户明确交代的信息。
 */
const CAPTURE_PATTERNS = [
  /(?:记住|提醒我|以后|别再|千万|一定|禁止|约定|规则|必须)/i,
  /(?:我喜欢|我讨厌|我的名字|我是|我偏好|我不吃|我的生日)/i,
  /(?:配置|账号|密钥|端口|路径|分支|仓库|版本|部署|环境变量)/i,
  /(?:决定|方案|改成|统一为|规范是|确定用|正式)/i,
  /(?:bug|报错|崩溃|失败|异常|排障|解决办法|原因是)/i,
]

const IGNORE_PATTERNS = [
  /^(?:在吗|你好|哈+|(?:谢谢|感谢)(?:你)?|好的|收到|ok|行|嗯|哦|66*)[!！。？?~～\s]*$/i,
]

/**
 * 判断一条对话内容或用户消息是否值得自动捕获为长期/半衰记忆。
 * 
 * @param {string} text 用户消息或对话段落
 * @returns {{ worth: boolean, reason?: string, topic?: string }}
 */
export function isWorthCapturing(text) {
  if (!text || typeof text !== 'string') return { worth: false }
  const t = text.trim()
  if (t.length < 5 || t.length > 120) return { worth: false }
  if (t.includes('## ') || t.includes('```')) return { worth: false }

  for (const ign of IGNORE_PATTERNS) {
    if (ign.test(t)) return { worth: false }
  }

  for (const pat of CAPTURE_PATTERNS) {
    if (pat.test(t)) {
      return { worth: true, reason: 'rule_matched', sample: t.slice(0, 50) }
    }
  }

  return { worth: false }
}

/**
 * 读取本地捕获存储（JSONL 格式）。
 * 
 * @param {string} filePath
 * @returns {Array<Object>}
 */
// 结果按 mtime + size 缓存：配额检查、召回、导航都会反复读同一个文件，
// 每次全量 readFileSync + 逐行 JSON.parse，语料一多就是主线程上的 O(N) 风暴。
const storeCache = new Map()

/** 追加写入之后必须调用，否则同一毫秒内的写入会读到旧快照。 */
export function invalidateCaptureCache(filePath) {
  storeCache.delete(filePath)
}

export function readCaptureStore(filePath) {
  try {
    const st = fs.statSync(filePath)
    const key = `${st.mtimeMs}:${st.size}`
    const hit = storeCache.get(filePath)
    if (hit && hit.key === key) return hit.records
    const content = fs.readFileSync(filePath, 'utf8')
    const records = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    storeCache.set(filePath, { key, records })
    return records
  } catch {
    return []
  }
}

/**
 * 检查并消耗当日配额。
 * 
 * @param {string} storePath JSONL 文件路径
 * @param {number} dailyQuota 每日最大条数上限（默认 10 条）
 * @param {string} [todayStr] 格式 YYYY-MM-DD，默认今天
 * @returns {{ allowed: boolean, countToday: number, remaining: number }}
 */
// 按本地时区算日期。之前用 toISOString().slice(0,10) 是 UTC 日期，
// UTC+8 的凌晨 0 点到 8 点会被算进前一天，配额在半夜错位重置。
export function localDateStr(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function checkDailyQuota(storePath, dailyQuota = 10, todayStr = localDateStr(Date.now())) {
  const records = readCaptureStore(storePath)
  let countToday = 0
  for (const r of records) {
    const raw = r.created_at || r.createdAt
    if (!raw) continue
    if (localDateStr(raw) === todayStr) {
      countToday += 1
    }
  }
  return {
    allowed: countToday < dailyQuota,
    countToday,
    remaining: Math.max(0, dailyQuota - countToday),
  }
}

/**
 * 自动捕获筛选并持久化写入独立存储。
 * 
 * 要求：
 * - 绝对不写 memory/ 目录（由外层配置或默认独立路径保证，如 DSH_HOME/autocapture/captures.jsonl 或自定义独立文件）
 * - 纯本地 JSONL 格式
 * - 严格带创建时间 created_at、权重 initialWeight 与配额控制
 * 
 * @param {Object} options
 * @param {string} options.text 文本内容
 * @param {string} options.storePath 存储 JSONL 路径（禁止位于 memory/）
 * @param {number} [options.dailyQuota=10] 每日配额
 * @param {number} [options.initialWeight=1.0] 初始权重 (0-1)
 * @param {boolean} [options.permanent=false] 是否永久不衰减
 * @param {string} [options.source='dialogue'] 来源
 * @param {boolean} [options.redact=true] 写入前是否把常见密钥/token 脱敏成 [REDACTED]
 * @param {number} [options.now=Date.now()] 当前时间戳
 * @returns {{ captured: boolean, reason?: string, record?: Object }}
 */
/**
 * 解析路径的真实位置。文件还不存在时退一步解析父目录，
 * 这样「先建软链、再往里写」的绕过手法也能被拦住。
 */
function realPathish(filePath) {
  let current = path.resolve(filePath)
  // 先解开软链本身。realpathSync 对「目标还不存在」的悬空链接会直接抛错，
  // 那时它会退化成链接自己所在目录，绕过检查——所以要先 readlink 拿到目标。
  try {
    if (fs.lstatSync(current).isSymbolicLink()) {
      current = path.resolve(path.dirname(current), fs.readlinkSync(current))
    }
  } catch {
    /* 不是链接或读不到，按原路径继续 */
  }
  try {
    return fs.realpathSync(current)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(current)), path.basename(current))
    } catch {
      return current
    }
  }
}

export function autoCapture(options) {
  const {
    text,
    storePath,
    dailyQuota = 10,
    initialWeight = 1.0,
    permanent = false,
    source = 'dialogue',
    redact = true,
    now = Date.now(),
  } = options || {}

  if (!text || !storePath) {
    return { captured: false, reason: 'missing_arguments' }
  }

  // 安全检查：坚决禁止写 memory 目录。
  // path.resolve 只看字面路径，一个指向 memory/ 的符号链接能轻松绕过去，
  // 所以先把真实路径解出来再判。
  const normalizedPath = realPathish(storePath).replace(/\\/g, '/')
  if (/(?:^|\/)memory(?:\/|$)/i.test(normalizedPath)) {
    throw new Error(`Security violation: autocapture is forbidden to write into memory directory: ${storePath}`)
  }

  const evalResult = isWorthCapturing(text)
  if (!evalResult.worth) {
    return { captured: false, reason: 'not_worth_capturing' }
  }

  const todayStr = localDateStr(now)
  const quota = checkDailyQuota(storePath, dailyQuota, todayStr)
  if (!quota.allowed) {
    return { captured: false, reason: 'daily_quota_exceeded', countToday: quota.countToday }
  }

  const rawText = text.trim()
  // 脱敏只影响落盘内容；是否值得捕获仍按原文的规则判断（避免密钥替换后误伤规则）。
  const storedText = redact === false ? rawText : sanitize(rawText)
  const id = 'cap-' + crypto.createHash('sha1').update(storedText).digest('hex').slice(0, 12)
  const createdAt = new Date(now).toISOString()

  const existing = readCaptureStore(storePath)
  if (existing.some((r) => r.id === id || r.text === storedText)) {
    return { captured: false, reason: 'duplicate_entry', id }
  }

  const record = {
    id,
    type: 'auto_capture',
    text: storedText,
    // 用 isFinite 判断而不是 ||：initialWeight = 0 是合法的「不参与召回」，
    // 用 || 会把它悄悄改成 1.0，和之前情感状态吞掉 arousal=0 是同一个错误模式
    weight: Math.max(0, Math.min(1, Number.isFinite(Number(initialWeight)) ? Number(initialWeight) : 1.0)),
    permanent: Boolean(permanent),
    created_at: createdAt,
    source,
    metadata: {
      capture_rule: evalResult.reason,
      day: todayStr,
    },
  }

  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.appendFileSync(storePath, JSON.stringify(record) + '\n', 'utf8')
    invalidateCaptureCache(storePath)
    return { captured: true, record, remainingQuota: quota.remaining - 1 }
  } catch (err) {
    return { captured: false, reason: 'write_failed', error: err.message }
  }
}
