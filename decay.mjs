/**
 * 记忆权重随时间半衰期衰减计算。
 * 纯数学与配置，无外部依赖。
 */

export const DEFAULT_HALF_LIFE_DAYS = 30
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * 限制数值在 [lo, hi] 范围内
 */
function clamp(val, lo = 0, hi = 1) {
  const n = Number(val)
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 计算衰减后的有效权重。
 * 
 * 公式：
 * - 永久条目 (entry.permanent === true / isPermanent): 权重不衰减，返回其初始权重（默认 1.0）
 * - 一般条目: weight(t) = initialWeight * 0.5 ^ (elapsedDays / halfLifeDays)
 * 
 * @param {Object} entry 包含 initialWeight, baseWeight, weight, createdAt, created_at, permanent 等
 * @param {number} [now] 当前时间戳 (ms)，默认 Date.now()
 * @param {number} [halfLifeDays] 半衰期天数，默认 30 天
 * @returns {number} 衰减后的权重 [0, 1]
 */
export function computeDecayedWeight(entry, now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (!entry || typeof entry !== 'object') return 0

  const baseWeight = clamp(
    entry.initialWeight !== undefined
      ? entry.initialWeight
      : (entry.baseWeight !== undefined
        ? entry.baseWeight
        : (entry.weight !== undefined ? entry.weight : 1.0)),
    0,
    1
  )

  const isPermanent = Boolean(
    entry.permanent ||
    entry.isPermanent ||
    entry.pinned ||
    (entry.meta && (entry.meta.permanent || entry.meta.pinned))
  )

  if (isPermanent) {
    return baseWeight
  }

  const rawCreated =
    entry.createdAt ||
    entry.created_at ||
    (entry.meta && (entry.meta.createdAt || entry.meta.created_at))

  if (!rawCreated) {
    // 若无创建时间，视同不衰减或即时创建
    return baseWeight
  }

  const createdTime = typeof rawCreated === 'number' ? rawCreated : Date.parse(rawCreated)
  if (Number.isNaN(createdTime) || createdTime > now) {
    return baseWeight
  }

  const elapsedDays = Math.max(0, (now - createdTime) / MS_PER_DAY)
  const effectiveHalfLife = Math.max(0.0001, Number(halfLifeDays) || DEFAULT_HALF_LIFE_DAYS)

  // 0.5 ^ (elapsedDays / halfLifeDays)
  const factor = Math.pow(0.5, elapsedDays / effectiveHalfLife)
  return clamp(baseWeight * factor, 0, 1)
}

/**
 * 调整评分：将 BM25 词面匹配得分与记忆衰减权重结合。
 * 保证权重降为接近 0 时条目排在后面，但不会被硬删除。
 *
 * @param {number} rawScore BM25 或基础打分
 * @param {Object} entry 包含权重与创建时间元信息
 * @param {number} [now]
 * @param {number} [halfLifeDays]
 * @returns {{ finalScore: number, weight: number }}
 */
export function applyScoreDecay(rawScore, entry, now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const weight = computeDecayedWeight(entry, now, halfLifeDays)
  // 当 entry 无特殊权重标注时，默认 weight 为 1.0，finalScore 等于 rawScore
  return {
    finalScore: rawScore * weight,
    weight,
  }
}
