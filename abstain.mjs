/**
 * 拒答判定（abstain）—— 纯函数：不读文件、不依赖 DSH、不碰全局状态。
 *
 * 存在的理由：recall() 的职责是「按分数排好序、取前 K 条」，它从不说
 * 「我没有相关记忆」。于是一条覆盖率 0.11、靠兜底通道硬凑出来的候选，
 * 和一条真命中的记忆长得一模一样，都会被塞进上下文变成看着很像样的假答案。
 * 这个模块只回答一个问题：手里这堆候选，该拿出来吗、拿得准吗。
 *
 * 三种 verdict 语义必须严格区分，混用会让调用方没法正确展示：
 *   answer     证据过线，且 top1 相对次优有明确优势
 *   ambiguous  有候选且证据也不差，但分不出主次 —— 调用方仍该展示候选，只是别当定论
 *   abstain    没有可信答案 —— 调用方应该直说不知道，而不是硬答
 *
 * 【为什么不用绝对分数阈值】
 * score = BM25 × 时间衰减，量纲跟着语料规模、查询长度、条目长度一起变：
 * 同一个 13 分，在 4 字查询上是碾压，在 14 字查询上只是及格。
 * 实测里无答案误召的那两条分数（13.1 / 13.5）比正确答案的中位数（9.1）还高，
 * 所以这里只用归一化量：
 *   coverage     已经是 0–1 的比值
 *   queryMatched 计数，配合查询长度一起看
 *   density      preDecayScore / 查询 bigram 数，把分数按查询长度归一化
 * 绝对分数只在 density 里以归一化形式进入，不参与硬阈值。
 *
 * 【证据线的依据】
 * 门槛与 recall() 严格通道同口径（cfg.minCoverage / cfg.minMatched）。
 * 严格通道保证过线候选满足 coverage ≥ minCoverage 且 matched ≥ minMatched，
 * 所以低于这条线的候选只可能来自兜底通道。这不是调参调出来的数，
 * 是召回层的结构决定的：兜底通道本来就是「尽力想起来」，它的产物
 * 必须被下游明确标成不可信，否则「换说法硬凑」会一路冒充正确答案。
 */

/** 阈值默认值，与 recall() 的严格通道默认值保持一致。 */
export const ABSTAIN_DEFAULTS = Object.freeze({
  minCoverage: 0.2,
  minMatched: 2,
  // top1 与 top2 的相对分差低于它就认为分不出主次
  margin: 0.15,
  // 归一化密度下限；默认 0 = 关闭。真实语料的密度下界受条目长度影响，
  // 没有放之四海的间隔，需要时按语料自行设。
  minDensity: 0,
})

export const VERDICT = Object.freeze({
  ANSWER: 'answer',
  AMBIGUOUS: 'ambiguous',
  ABSTAIN: 'abstain',
})

export const REASON = Object.freeze({
  NO_HITS: 'no-hits',
  EXPANSION_ONLY: 'expansion-only',
  WEAK_MATCHED: 'weak-matched',
  WEAK_COVERAGE: 'weak-coverage',
  WEAK_DENSITY: 'weak-density',
  CLOSE_CANDIDATES: 'close-candidates',
  STRONG_EVIDENCE: 'strong-evidence',
})

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const round3 = (x) => Math.round(clamp01(x) * 1000) / 1000

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 与 index.js 的 grams() 同一口径：去空白 + 小写，再取 bigram。 */
function gramCount(query) {
  const t = String(query ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const n = t.length > 1 ? t.length - 1 : t.length
  return Math.max(1, n)
}

function queryMatchedOf(hit) {
  return num(hit.queryMatched ?? hit.matched, 0)
}

function coverageOf(hit) {
  return clamp01(num(hit.coverage, 0))
}

function densityOf(hit, grams) {
  const preDecay = num(hit.preDecayScore ?? hit.rawScore ?? hit.score, 0)
  return preDecay / grams
}

/** 记忆身份。拿不到身份就返回 null，表示这条不参与去重。 */
function entryKey(hit) {
  const e = hit.entry
  if (!e || typeof e !== 'object') return null
  if (e.id != null) return 'id:' + e.id
  if (e.source_id != null) return 'src:' + e.source_id
  if (typeof e.text === 'string') return 'text:' + e.text.slice(0, 64)
  return null
}

/** 单条候选的证据强度，0–1。过线之后还剩多少余量，决定它有多可信。 */
function evidenceStrength(cov, matched, density, minCoverage, minMatched) {
  const covFull = Math.max(minCoverage + 0.05, 0.6)
  const matchedFull = Math.max(minMatched + 1, 6)
  const covRatio = clamp01((cov - minCoverage) / (covFull - minCoverage))
  const matchedRatio = clamp01((matched - minMatched) / (matchedFull - minMatched))
  const densityRatio = clamp01(density / 1.5)
  return 0.4 * covRatio + 0.4 * matchedRatio + 0.2 * densityRatio
}

/**
 * 判断一组召回候选该不该被当作答案拿出来。
 *
 * @param {Array<object>} hits RecallHit[]，不要求已排序（这里自己排）
 * @param {string} query 原始查询，用来把分数按查询长度归一化
 * @param {object} [cfg] 覆盖 ABSTAIN_DEFAULTS 中的阈值
 * @returns {{verdict: 'answer'|'ambiguous'|'abstain', evidenceStrength: number, reason: string}}
 *   evidenceStrength 是**启发式证据强度**（过线之后的余量），不是校准概率；
 *   abstain 恒为 0。它只在同一个 verdict 内部单调，
 *   **不能跨 verdict 比较**：实测 answer 可以低到 0.393，而 ambiguous 可以高到 0.495。
 *   旧字段 confidence 已删除——那个名字会被误读成「有 82% 概率正确」，本轮不再暴露。
 */
export function decide(hits, query, cfg = {}) {
  const options = cfg || {}
  const minCoverage = num(options.minCoverage, ABSTAIN_DEFAULTS.minCoverage)
  const minMatched = num(options.minMatched, ABSTAIN_DEFAULTS.minMatched)
  const marginLimit = num(options.margin, ABSTAIN_DEFAULTS.margin)
  const minDensity = num(options.minDensity, ABSTAIN_DEFAULTS.minDensity)

  const grams = gramCount(query)

  // evidenceStrength 是**启发式证据强度**，不是概率校准后的置信度。
  // 「0.82」不代表「82% 概率正确」——它只是覆盖率、命中数、密度的加权组合，
  // 权重是手写的，没有任何标注数据拟合过。
  // 跨 verdict 不可比：answer 的下限（0.393）低于 ambiguous 的上限（0.495），
  // 所以 0.45 这个数字本身不说明「更该信哪一边」，展示时必须带上 verdict。
  const abstain = (reason) => ({
    verdict: VERDICT.ABSTAIN,
    evidenceStrength: 0,
    reason,
  })

  // 1) 归一化候选：丢掉不能参与比较的条目，按分数从高到低排。
  //    不信任调用方的顺序，排序是这里唯一的事实来源。
  const scored = []
  if (Array.isArray(hits)) {
    for (const hit of hits) {
      if (!hit || typeof hit !== 'object') continue
      const score = num(hit.score, 0)
      if (!(score > 0)) continue
      scored.push({ hit, score, key: entryKey(hit) })
    }
  }
  scored.sort((a, b) => b.score - a.score)

  // 同一条记忆只留最高分的那次。否则同一条出现两次会被误读成「两个候选不相上下」。
  const seen = new Set()
  const candidates = []
  for (const item of scored) {
    if (item.key != null) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
    }
    candidates.push(item)
  }

  if (candidates.length === 0) return abstain(REASON.NO_HITS)

  const top = candidates[0]
  const matched = queryMatchedOf(top.hit)
  const cov = coverageOf(top.hit)
  const expansionMatched = num(top.hit.expansionMatched, 0)

  // 2) 硬拒答。顺序有意义：先认「原始词面一点没中、全靠扩展撑起来」，
  //    这是最典型的假命中，理由要说清是扩展而不是覆盖率。
  if (matched === 0 && expansionMatched > 0) return abstain(REASON.EXPANSION_ONLY)
  if (matched < minMatched) return abstain(REASON.WEAK_MATCHED)
  if (cov < minCoverage) return abstain(REASON.WEAK_COVERAGE)

  const density = densityOf(top.hit, grams)
  if (minDensity > 0 && density < minDensity) return abstain(REASON.WEAK_DENSITY)

  // 3) 证据过线了，再看有没有「证据同样够、分数却咬得很紧」的竞争者。
  //    噪声候选不能制造 ambiguous —— 那会把「选不准」和「有噪声」混为一谈。
  let margin = 1
  const runner = candidates[1]
  if (runner) {
    const runnerMatched = queryMatchedOf(runner.hit)
    const runnerCov = coverageOf(runner.hit)
    const runnerViable = runnerMatched >= minMatched && runnerCov >= minCoverage
    if (runnerViable) margin = clamp01((top.score - runner.score) / top.score)
  }

  const strength = evidenceStrength(cov, matched, density, minCoverage, minMatched)

  if (margin < marginLimit) {
    const s = round3(0.25 + 0.35 * strength)
    return {
      verdict: VERDICT.AMBIGUOUS,
      evidenceStrength: s,
      reason: REASON.CLOSE_CANDIDATES,
    }
  }

  // 分差越大越敢下结论；单候选时 margin = 1，不打折
  const s = round3((0.35 + 0.65 * strength) * (0.85 + 0.15 * margin))
  return {
    verdict: VERDICT.ANSWER,
    evidenceStrength: s,
    reason: REASON.STRONG_EVIDENCE,
  }
}

export default decide
