import assert from 'node:assert/strict'
import { decide, ABSTAIN_DEFAULTS, VERDICT, REASON } from '../abstain.mjs'

/**
 * abstain.decide 的边界测试。
 *
 * 这里不构造真实召回：decide 的接口就是为了能被独立喂数据。
 * 每条用例都直接指定 score / coverage / queryMatched，
 * 断言的是「给定这样的证据，应该判成什么」，不是「检索质量如何」。
 */

const QUERY = '项目数据库用的是哪个' // 8 个 bigram，用来验证密度归一化

// 一条形状与 RecallHit 一致的候选
function hit(id, score, coverage, queryMatched, extra = {}) {
  return {
    entry: { id, text: '记忆正文 ' + id, source_id: 'dialogue:' + id },
    score,
    rawScore: score,
    queryScore: score,
    expansionScore: 0,
    effectiveExpansionScore: 0,
    preDecayScore: score,
    weight: 1,
    coverage,
    matched: queryMatched,
    queryMatched,
    expansionMatched: 0,
    ...extra,
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------- abstain：根本不该拿出来 ----------

test('空召回判 abstain', () => {
  const r = decide([], QUERY)
  assert.equal(r.verdict, 'abstain')
  assert.equal(r.evidenceStrength, 0)
  assert.equal(r.reason, 'no-hits')
})

test('非法输入防御：null / 非数组 / 全无效', () => {
  assert.equal(decide(null, QUERY).verdict, 'abstain')
  assert.equal(decide(undefined, QUERY).verdict, 'abstain')
  assert.equal(decide('不是数组', QUERY).verdict, 'abstain')
  assert.equal(decide([null, {}, { score: 0 }], QUERY).verdict, 'abstain')
  assert.equal(decide([null, {}, { score: 0 }], QUERY).reason, 'no-hits')
})

test('只有扩展命中、原始词面零命中，判 abstain 且理由不是覆盖率', () => {
  // coverage 必然为 0（它是 queryMatched / gram 总数），
  // 但必须先认「扩展独占」而不是笼统说覆盖率不够
  const r = decide([hit('a', 9, 0, 0, { expansionMatched: 3 })], QUERY)
  assert.equal(r.verdict, 'abstain')
  assert.equal(r.reason, 'expansion-only')
  assert.equal(r.evidenceStrength, 0)
})

test('覆盖率过低判 abstain', () => {
  const r = decide([hit('a', 9, 0.1, 3)], QUERY)
  assert.equal(r.verdict, 'abstain')
  assert.equal(r.reason, 'weak-coverage')
})

test('命中片段太少判 abstain', () => {
  const r = decide([hit('a', 9, 0.3, 1)], QUERY)
  assert.equal(r.verdict, 'abstain')
  assert.equal(r.reason, 'weak-matched')
})

test('多候选中没有任何一条过证据线，仍判 abstain', () => {
  const r = decide([hit('a', 9, 0.1, 1), hit('b', 8, 0.12, 1)], QUERY)
  assert.equal(r.verdict, 'abstain')
})

test('minDensity 打开后极稀疏的证据判 abstain', () => {
  const r = decide([hit('a', 2, 0.5, 4)], QUERY, { minDensity: 100 })
  assert.equal(r.verdict, 'abstain')
  assert.equal(r.reason, 'weak-density')
})

// ---------- answer：证据足够且有主次 ----------

test('单条强证据判 answer', () => {
  const r = decide([hit('a', 10, 0.5, 4)], QUERY)
  assert.equal(r.verdict, 'answer')
  assert.equal(r.reason, 'strong-evidence')
  assert.ok(r.evidenceStrength > 0.5, '强证据的证据强度应明显高于中段，实际 ' + r.evidenceStrength)
  assert.ok(r.evidenceStrength <= 1)
})

test('两条差距明显时判 answer，不是 ambiguous', () => {
  const r = decide([hit('a', 10, 0.5, 4), hit('b', 4, 0.4, 3)], QUERY)
  assert.equal(r.verdict, 'answer', '分差很大说明选得准，不该退化成「选不准」')
})

test('次优证据本身不合格时不制造 ambiguous', () => {
  // top2 分数非常接近，但它自己的证据根本没到线 —— 那是噪声，不是并列
  const r = decide([hit('a', 10, 0.5, 4), hit('b', 9.9, 0.1, 1)], QUERY)
  assert.equal(r.verdict, 'answer')
})

// ---------- ambiguous：有东西但选不准 ----------

test('两个都合格且分差过小，判 ambiguous', () => {
  const r = decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY)
  assert.equal(r.verdict, 'ambiguous')
  assert.equal(r.reason, 'close-candidates')
  assert.ok(r.evidenceStrength > 0 && r.evidenceStrength < 1)
})

test('ambiguous 的证据强度必须低于同等证据的 answer', () => {
  const single = decide([hit('a', 10, 0.5, 4)], QUERY)
  const tied = decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY)
  assert.equal(single.verdict, 'answer')
  assert.equal(tied.verdict, 'ambiguous')
  assert.ok(tied.evidenceStrength < single.evidenceStrength)
})

test('ambiguous 与 abstain 语义不同：前者仍带候选证据强度，后者恒为 0', () => {
  const ambiguous = decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY)
  const abstained = decide([hit('a', 10, 0.1, 1)], QUERY)
  assert.equal(ambiguous.verdict, 'ambiguous')
  assert.equal(abstained.verdict, 'abstain')
  assert.ok(ambiguous.evidenceStrength > 0)
  assert.equal(abstained.evidenceStrength, 0)
})

// ---------- 不依赖调用方顺序 ----------

test('乱序输入也按分数重新排序', () => {
  const r = decide([hit('low', 3, 0.25, 2), hit('high', 12, 0.6, 5)], QUERY)
  assert.equal(r.verdict, 'answer')
  // 若没排序，会把 low 当 top1（覆盖率 0.25、命中 2），证据强度会明显更低
  assert.ok(r.evidenceStrength > 0.6, '应按最高分的候选来判，实际 ' + r.evidenceStrength)
})

// ---------- 去重 ----------

test('同一条记忆重复出现不被误判成并列', () => {
  const r = decide([hit('same', 10, 0.5, 4), hit('same', 9.9, 0.5, 4)], QUERY)
  assert.equal(r.verdict, 'answer', '重复候选是同一份证据，不该算两个')
})

// ---------- cfg 覆盖 ----------

test('cfg 能抬高证据线，让原本的 answer 变 abstain', () => {
  const base = decide([hit('a', 10, 0.3, 3)], QUERY)
  const strict = decide([hit('a', 10, 0.3, 3)], QUERY, { minCoverage: 0.5 })
  assert.equal(base.verdict, 'answer')
  assert.equal(strict.verdict, 'abstain')
  assert.equal(strict.reason, 'weak-coverage')
})

test('cfg 能放宽分差线，让原本的 ambiguous 变 answer', () => {
  const tied = decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY)
  const loose = decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY, { margin: 0.01 })
  assert.equal(tied.verdict, 'ambiguous')
  assert.equal(loose.verdict, 'answer')
})

test('未传 cfg 时使用默认阈值', () => {
  assert.equal(ABSTAIN_DEFAULTS.minCoverage, 0.2)
  assert.equal(ABSTAIN_DEFAULTS.minMatched, 2)
  // 刚好卡在默认线上：0.2 / 2 应当通过，0.19 / 2 应当拒绝
  assert.equal(decide([hit('a', 10, 0.2, 2)], QUERY).verdict, 'answer')
  assert.equal(decide([hit('a', 10, 0.19, 2)], QUERY).verdict, 'abstain')
})

// ---------- 契约：形状、纯函数、单调性 ----------

test('返回值形状恒定', () => {
  const samples = [
    decide([], QUERY),
    decide([hit('a', 10, 0.5, 4)], QUERY),
    decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY),
  ]
  for (const r of samples) {
    assert.ok(Object.values(VERDICT).includes(r.verdict), '未知 verdict ' + r.verdict)
    assert.equal(typeof r.evidenceStrength, 'number')
    assert.ok(r.evidenceStrength >= 0 && r.evidenceStrength <= 1, 'evidenceStrength 越界 ' + r.evidenceStrength)
    assert.ok(!('confidence' in r), '不应再暴露 confidence 这个未校准的名字')
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 0)
  }
  for (const reason of Object.values(REASON)) assert.equal(typeof reason, 'string')
})

test('纯函数：不改动传入的 hits 数组与其中的对象', () => {
  const hits = [hit('a', 5, 0.3, 3), hit('b', 10, 0.5, 4)]
  const before = JSON.stringify(hits)
  decide(hits, QUERY)
  assert.equal(JSON.stringify(hits), before, 'decide 不应修改入参')
})

test('证据越强证据强度越高（单调）', () => {
  const weak = decide([hit('a', 6, 0.25, 2)], QUERY)
  const strong = decide([hit('a', 20, 0.7, 8)], QUERY)
  assert.equal(weak.verdict, 'answer')
  assert.equal(strong.verdict, 'answer')
  assert.ok(strong.evidenceStrength > weak.evidenceStrength)
})

test('分差变小会降低 answer 的证据强度', () => {
  const alone = decide([hit('a', 10, 0.5, 4)], QUERY)
  const contested = decide([hit('a', 10, 0.5, 4), hit('b', 8, 0.5, 4)], QUERY)
  assert.equal(alone.verdict, 'answer')
  assert.equal(contested.verdict, 'answer')
  assert.ok(contested.evidenceStrength < alone.evidenceStrength, '有相近竞争者时应更保守')
})

// ---------- 校准声明：只是启发式，不是置信度 ----------

test('返回对象不叫 confidence：那个名字没校准过', () => {
  const samples = [
    decide([], QUERY),
    decide([hit('a', 10, 0.5, 4)], QUERY),
    decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], QUERY),
  ]
  for (const r of samples) {
    assert.ok(!('confidence' in r), 'decide 只暴露 evidenceStrength')
  }
})

test('evidenceStrength 跨 verdict 不可横向比较（不是概率）', () => {
  // 刚好过线的 answer 只有很低的过线余量；证据很足但分不出主次的 ambiguous 反而更高。
  // 实测冻结集里 answer 低到 0.393、ambiguous 高到 0.495，两个区间是重叠的。
  // 所以这个数不能被当成「正确概率」，也不能拿它跨 verdict 排序。
  const minimalAnswer = decide([hit('a', 1, 0.2, 2)], QUERY)
  const strongAmbiguous = decide([hit('a', 10, 0.75, 8), hit('b', 9.95, 0.75, 8)], QUERY)
  assert.equal(minimalAnswer.verdict, 'answer')
  assert.equal(strongAmbiguous.verdict, 'ambiguous')
  assert.ok(
    strongAmbiguous.evidenceStrength > minimalAnswer.evidenceStrength,
    '这道用例存在，正是为了证明两个 verdict 的数值区间会重叠',
  )
})

test('cfg 里是 NaN / undefined 时回落到默认阈值，不会静默放宽证据线', () => {
  const below = [hit('a', 10, 0.19, 2)]
  const onLine = [hit('a', 10, 0.2, 2)]
  const bogus = { minCoverage: NaN, minMatched: undefined, margin: NaN, minDensity: NaN }
  assert.equal(decide(below, QUERY).verdict, 'abstain')
  assert.equal(decide(below, QUERY, bogus).verdict, 'abstain')
  assert.equal(decide(onLine, QUERY).verdict, 'answer')
  assert.equal(decide(onLine, QUERY, bogus).verdict, 'answer')
})

// ---------- runner ----------

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('ok   ' + t.name)
  } catch (e) {
    failed += 1
    console.error('FAIL ' + t.name)
    console.error('     ' + (e && e.message))
  }
}

console.log('')
console.log((tests.length - failed) + '/' + tests.length + ' passed')
if (failed > 0) process.exitCode = 1
