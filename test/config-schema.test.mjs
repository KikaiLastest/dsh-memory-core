import assert from 'node:assert'
import {
  DEFAULTS,
  FIELD_DEFS,
  GROUPS,
  fieldDescriptors,
  groupDescriptors,
  normalizeConfig,
  validatePatch,
} from '../config.mjs'

// 1. 表本身：16 个参数、key 不重复、字符串/数字/布尔都有范围或默认值
assert.equal(FIELD_DEFS.length, 16, '16 个可调参数')
const keys = FIELD_DEFS.map((f) => f.key)
assert.equal(new Set(keys).size, keys.length, 'key 不重复')
for (const f of FIELD_DEFS) {
  assert.ok(f.label && f.label.length > 0, f.key + ' 有中文标签')
  assert.ok(GROUPS.some((g) => g.id === f.group), f.key + ' 的分组存在')
  assert.ok(f.key in DEFAULTS, f.key + ' 有默认值')
}
for (const f of FIELD_DEFS) {
  if (f.type !== 'number') continue
  assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max), f.key + ' 有范围')
  assert.ok(f.min <= f.max, f.key + ' 范围合法')
  assert.ok(f.default >= f.min && f.default <= f.max, f.key + ' 默认值在范围内')
}
console.log('schema ->', FIELD_DEFS.length, 'fields,', GROUPS.length, 'groups')

// 1b. 新增的导航 / 总结 / 脱敏参数：默认值与类型都对
const byKey = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f]))
assert.equal(byKey.enableMemoryNav.type, 'boolean')
assert.equal(byKey.enableMemoryNav.default, true)
assert.equal(byKey.enableSummary.type, 'boolean')
assert.equal(byKey.enableSanitize.type, 'boolean')
assert.equal(byKey.summaryMaxChars.type, 'number')
assert.equal(byKey.summaryMaxChars.default, 600)
assert.equal(byKey.summarizeIntervalMinutes.default, 10)
assert.equal(byKey.summarizeIdleMinutes.default, 30)
assert.equal(byKey.summaryMaxChars.group, 'summary', '新参数归到 summary 分组')
assert.ok(GROUPS.some((g) => g.id === 'summary'), 'summary 分组存在')

// 2. normalizeConfig：坏值退回默认值，越界夹回范围，0 不被当成空
const dflt = normalizeConfig({})
assert.deepEqual(dflt, DEFAULTS, '空配置 = 默认值')
const clamped = normalizeConfig({ topK: 99, minCoverage: 7, dailyQuota: -3 })
assert.equal(clamped.topK, 10, 'topK 夹到上限')
assert.equal(clamped.minCoverage, 1, 'minCoverage 夹到上限')
assert.equal(clamped.dailyQuota, 0, 'dailyQuota 夹到下限 0（0 是合法值）')
const zeroes = normalizeConfig({ minCoverage: 0, dailyQuota: 0 })
assert.equal(zeroes.minCoverage, 0, 'minCoverage=0 保留')
assert.equal(zeroes.dailyQuota, 0, 'dailyQuota=0 保留')
assert.equal(normalizeConfig({ topK: 'abc' }).topK, DEFAULTS.topK, '非数字退回默认')
assert.equal(normalizeConfig({ memoryRoot: '   ' }).memoryRoot, DEFAULTS.memoryRoot, '空路径退回默认')
assert.equal(normalizeConfig({ enableStable: false }).enableStable, false, '显式 false 保留')
const summaryClamp = normalizeConfig({ summaryMaxChars: 5, summarizeIntervalMinutes: 99999 })
assert.equal(summaryClamp.summaryMaxChars, 80, 'summaryMaxChars 夹到下限')
assert.equal(summaryClamp.summarizeIntervalMinutes, 1440, '总结间隔夹到上限')
assert.equal(normalizeConfig({ enableMemoryNav: false }).enableMemoryNav, false, '导航开关 false 保留')
assert.equal(normalizeConfig({}).summaryMaxChars, 600, '导航长度默认 600')
console.log('normalize -> clamp/zero/default ok')

// 3. validatePatch：合法改动通过、越界与类型错误被点名
const good = validatePatch({ topK: 5, minCoverage: 0.35, enableAutoCapture: false, memoryRoot: ' D:/m ' })
assert.equal(good.ok, true, '合法改动通过')
assert.equal(good.values.topK, 5)
assert.equal(good.values.minCoverage, 0.35)
assert.equal(good.values.enableAutoCapture, false)
assert.equal(good.values.memoryRoot, 'D:/m', '路径去掉首尾空格')
assert.equal('dialogueFile' in good.values, false, '没传的字段不动')

const badRange = validatePatch({ topK: 11 })
assert.equal(badRange.ok, false)
assert.match(badRange.errors.topK, /1–10/, '越界报出范围')

const badType = validatePatch({ enableStable: 'yes' })
assert.equal(badType.ok, false, '布尔传字符串要拒绝')

const badText = validatePatch({ dialogueFile: '   ' })
assert.equal(badText.ok, false, '空路径要拒绝')

const badNumber = validatePatch({ timeoutMs: '很快' })
assert.equal(badNumber.ok, false, '非数字要拒绝')

const badSummary = validatePatch({ summaryMaxChars: 5000 })
assert.equal(badSummary.ok, false, '导航长度越界要拒绝')
assert.match(badSummary.errors.summaryMaxChars, /80–2000/, '报出导航长度范围')

const goodSummary = validatePatch({ enableSanitize: false, summarizeIdleMinutes: 45, enableMemoryNav: false })
assert.equal(goodSummary.ok, true, '新增开关与间隔能保存')
assert.equal(goodSummary.values.enableSanitize, false)
assert.equal(goodSummary.values.summarizeIdleMinutes, 45)
assert.equal(goodSummary.values.enableMemoryNav, false)

const empty = validatePatch({})
assert.equal(empty.ok, false, '空改动要拒绝')
console.log('validate -> ok/reject ok')

// 4. 给客户端的描述是纯数据（能 JSON 序列化，才发得出去）
const descriptors = fieldDescriptors()
assert.equal(descriptors.length, FIELD_DEFS.length)
assert.deepEqual(JSON.parse(JSON.stringify(descriptors)), descriptors, '字段描述可序列化')
assert.equal(groupDescriptors().length, GROUPS.length)
assert.equal(typeof descriptors[0].hint, 'string')
console.log('descriptors -> serializable,', descriptors.length, 'items')

console.log('CONFIG SCHEMA PASSED')
