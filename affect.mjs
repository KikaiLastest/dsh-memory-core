import fs from 'node:fs'
import path from 'node:path'

export const BASELINE = { valence: 0, arousal: 0.3 }
export const LIMITS = { valence: [-1, 1], arousal: [0, 1] }
export const DECAY_PER_HOUR = 0.1

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))

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
      valence: clamp(Number(raw.valence) || 0, LIMITS.valence),
      arousal: clamp(Number(raw.arousal) || BASELINE.arousal, LIMITS.arousal),
      trigger: raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : defaultState().trigger,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
      applied: Array.isArray(raw.applied) ? raw.applied.filter((x) => typeof x === 'string').slice(-200) : [],
    }
  } catch {
    return defaultState()
  }
}

export function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
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

/** 应用一个事件；按 eventId 去重，限幅。 */
export function applyEvent(state, event, now = Date.now()) {
  if (!event || !event.kind) return state
  const id = event.eventId || event.kind + ':' + Math.floor(now / 60000)
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
