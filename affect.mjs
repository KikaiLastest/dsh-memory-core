import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const BASELINE = { valence: 0, arousal: 0.3 }
export const LIMITS = { valence: [-1, 1], arousal: [0, 1] }
export const DECAY_PER_HOUR = 0.1

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))

/**
 * 只接受有限数值。
 * 合法的 0 必须保留 —— 旧写法 `Number(x) || fallback` 会把 arousal=0 悄悄换成 0.3，
 * 让系统永远回不到「平静」状态。null / undefined / '' / NaN / Infinity / 非数字类型才回退。
 */
function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 最近一次读写失败的原因（成功时清空）。插件不该因此中断对话，但也不该静默失明。 */
let lastError = null
export function getLastError() {
  return lastError
}

export function defaultState() {
  return {
    valence: BASELINE.valence,
    arousal: BASELINE.arousal,
    trigger: { event_id: null, kind: 'initial', updated_at: null },
    updated_at: null,
    applied: [],
  }
}

export function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return defaultState()
    return {
      valence: clamp(finiteOr(raw.valence, BASELINE.valence), LIMITS.valence),
      arousal: clamp(finiteOr(raw.arousal, BASELINE.arousal), LIMITS.arousal),
      trigger: raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : defaultState().trigger,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
      applied: Array.isArray(raw.applied) ? raw.applied.filter((x) => typeof x === 'string').slice(-200) : [],
    }
  } catch (error) {
    // 文件不存在是正常首次运行；其余（损坏 / 权限 / 编码）必须留下痕迹
    if (error && error.code !== 'ENOENT') {
      lastError = { at: new Date().toISOString(), op: 'load', file, message: String(error.message || error) }
    }
    return defaultState()
  }
}

export function saveState(file, state) {
  // 临时文件名必须唯一：固定 '.tmp' 在两路并发写同一状态文件时会互相覆盖，
  // 极端情况下 rename 到一半被另一路改掉，留下半份数据。
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    lastError = null
    return true
  } catch (error) {
    lastError = { at: new Date().toISOString(), op: 'save', file, message: String((error && error.message) || error) }
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件没建出来或已被清掉 */
    }
    return false
  }
}

/** 按小时向基线衰减；返回新状态。 */
export function decay(state, now = Date.now()) {
  const last = Date.parse(state.updated_at || '') || now
  const hours = Math.max(0, (now - last) / 3600000)
  if (hours < 1) return state
  const k = 1 - Math.exp(-hours * DECAY_PER_HOUR)
  return {
    ...state,
    valence: clamp(state.valence + (BASELINE.valence - state.valence) * k, LIMITS.valence),
    arousal: clamp(state.arousal + (BASELINE.arousal - state.arousal) * k, LIMITS.arousal),
    updated_at: new Date(now).toISOString(),
  }
}

const RULES = [
  { kind: 'praise', match: /谢谢|感谢|厉害|牛|不错|好用|最最最好|夸你|爱你/i, valence: 0.15, arousal: 0.05 },
  { kind: 'scold', match: /废物|垃圾|干死|傻|滚|妈的|烦死|闭嘴/i, valence: -0.2, arousal: 0.1 },
  { kind: 'affection', match: /摸摸|亲亲|抱抱|啵啵|揉揉|贴贴|想你/i, valence: 0.1, arousal: 0.15 },
  { kind: 'serious', match: /帮我|请问|故障|报错|崩溃|怎么解决|拜托/i, valence: 0.05, arousal: -0.1 },
  { kind: 'casual', match: /哈哈|乐|笑死|摸鱼|打游戏|炉石/i, valence: 0.05, arousal: 0.1 },
]

/** 用规则表把一条用户消息映射成事件；无匹配返回 null。 */
export function classify(text) {
  const t = String(text || '')
  for (const r of RULES) {
    if (r.match.test(t)) return { kind: r.kind, valence: r.valence, arousal: r.arousal }
  }
  return null
}

/** 进程内事件序号，只用于没有稳定 eventId 时的兜底。 */
let seq = 0

/** 应用一个事件；按 eventId 去重，限幅。 */
export function applyEvent(state, event, now = Date.now()) {
  if (!event || !event.kind) return state
  // 没有显式 eventId 时不能只靠分钟桶：同一分钟内两条同类事件会拿到同一个 ID，
  // 第二条被当成重放丢掉。加序号保证不同事件不合并；
  // 真正的重放去重仍由调用方传稳定 eventId（index.js 用消息内容哈希）。
  const id = event.eventId || `${event.kind}:${now}:${(seq = (seq + 1) % 1e9)}`
  if (state.applied.includes(id)) return state
  return {
    ...state,
    valence: clamp(state.valence + (event.valence || 0), LIMITS.valence),
    arousal: clamp(state.arousal + (event.arousal || 0), LIMITS.arousal),
    trigger: { event_id: id, kind: event.kind, updated_at: new Date(now).toISOString() },
    updated_at: new Date(now).toISOString(),
    applied: [...state.applied, id].slice(-200),
  }
}

/** 状态 → 一句语气提示；中性时返回空串。 */
export function toneHint(state) {
  const v = state.valence
  const a = state.arousal
  if (v <= -0.35) return '当前状态：有点蔫。少嘴硬、别开玩笑，认真一点。'
  if (v >= 0.35 && a >= 0.6) return '当前状态：心情不错且活跃，可以活泼一点，但别啰嗦。'
  if (v >= 0.35) return '当前状态：心情不错，语气可以松一点。'
  if (a >= 0.7) return '当前状态：有点亢奋，说话可以更短更快。'
  return ''
}
