import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
export function readCaptureStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf8')
    return content
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
export function checkDailyQuota(storePath, dailyQuota = 10, todayStr = new Date().toISOString().slice(0, 10)) {
  const records = readCaptureStore(storePath)
  let countToday = 0
  for (const r of records) {
    const d = (r.created_at || r.createdAt || '').slice(0, 10)
    if (d === todayStr) {
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
 * @param {number} [options.now=Date.now()] 当前时间戳
 * @returns {{ captured: boolean, reason?: string, record?: Object }}
 */
export function autoCapture(options) {
  const {
    text,
    storePath,
    dailyQuota = 10,
    initialWeight = 1.0,
    permanent = false,
    source = 'dialogue',
    now = Date.now(),
  } = options || {}

  if (!text || !storePath) {
    return { captured: false, reason: 'missing_arguments' }
  }

  // 安全检查：坚决禁止写 memory 目录
  const normalizedPath = path.normalize(path.resolve(storePath)).replace(/\\/g, '/')
  if (/(?:^|\/)memory(?:\/|$)/i.test(normalizedPath)) {
    throw new Error(`Security violation: autocapture is forbidden to write into memory directory: ${storePath}`)
  }

  const evalResult = isWorthCapturing(text)
  if (!evalResult.worth) {
    return { captured: false, reason: 'not_worth_capturing' }
  }

  const todayStr = new Date(now).toISOString().slice(0, 10)
  const quota = checkDailyQuota(storePath, dailyQuota, todayStr)
  if (!quota.allowed) {
    return { captured: false, reason: 'daily_quota_exceeded', countToday: quota.countToday }
  }

  const id = 'cap-' + crypto.createHash('sha1').update(text.trim()).digest('hex').slice(0, 12)
  const createdAt = new Date(now).toISOString()

  const existing = readCaptureStore(storePath)
  if (existing.some((r) => r.id === id || r.text === text.trim())) {
    return { captured: false, reason: 'duplicate_entry', id }
  }

  const record = {
    id,
    type: 'auto_capture',
    text: text.trim(),
    weight: Math.max(0, Math.min(1, Number(initialWeight) || 1.0)),
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
    return { captured: true, record, remainingQuota: quota.remaining - 1 }
  } catch (err) {
    return { captured: false, reason: 'write_failed', error: err.message }
  }
}
