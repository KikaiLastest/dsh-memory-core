#!/usr/bin/env node
// 冻结集质量回归检测：两级门禁。
//
// 第 1 级 —— 硬安全门禁（无容忍度）：
//   - 过期身份泄漏（superseded/archived 记录被返回）必须为 0；
//   - 返回结果必须都能判定身份（否则泄漏检测本身失效）；
//   - 身份判定器必须与语料/状态表对齐；
//   - 结构注入 / 凭证泄漏的安全回归测试必须全绿。
//   这一级没有 BASELINE、没有 TOLERANCE，任何一条不满足都直接红。
//
// 第 2 级 —— 质量门禁（有容忍度）：
//   - Recall@1 / Recall@3 / MRR 不许比基线掉太多；
//   - 无答案误召、内容污染不许比基线涨太多；
//   - p95 延迟不许比基线涨太多。
//   这一级的容忍度是有意的：宁可漏报一次小抖动，也不要让 CI 天天红。
//
// 指标本身由 scripts/quality-frozen.mjs 产出（JSON），这里只做判定，
// 不在脚本里重新算分，避免门禁和报告两套口径。
//
// 退出码：0 全绿；1 只有质量门禁失败；2 硬安全门禁失败（优先级更高）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// 质量基线（BASELINE.md 记录）。前四项保持旧值不动，避免「顺手调阈值让指标好看」。
// contentPollution / latencyP95 是本次新增的维度：基线取 76a81fc 上的实测值，
// 只用于发现退化，不代表「这个数就是好」。
export const BASELINE = {
  recall1: 48.1,
  recall3: 49.6,
  mrr: 0.489,
  noAnswerFp: 8.3,
  contentPollution: 1.7,
  latencyP95: 5.0,
}

// 允许的退化幅度：召回按百分点，MRR 按绝对值，延迟按毫秒。
export const TOLERANCE = {
  recall1: 2.0,
  recall3: 2.0,
  mrr: 0.03,
  noAnswerFp: 2.0,
  contentPollution: 2.0,
  latencyP95: 20.0,
}

const fmt = (v, unit = '') => (v === null || v === undefined ? 'n/a' : v.toFixed(3) + unit)
const displayWidth = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)))

function metricPercent(report, key) {
  const m = report && report.metrics ? report.metrics[key] : null
  return m && typeof m.value === 'number' ? m.value * 100 : null
}

function qualityRow({ id, label, current, baseline, tolerance, higherBetter, unit = '' }) {
  if (current === null || current === undefined || Number.isNaN(current)) {
    return { id, label, ok: false, detail: '报告缺少该指标，无法判定（fail-closed）' }
  }
  const threshold = higherBetter ? baseline - tolerance : baseline + tolerance
  const ok = higherBetter ? current >= threshold : current <= threshold
  const loss = higherBetter ? baseline - current : current - baseline
  return {
    id,
    label,
    ok,
    detail:
      '基线 ' + fmt(baseline, unit) + ' 当前 ' + fmt(current, unit) +
      ' 退化 ' + (loss >= 0 ? '+' : '') + loss.toFixed(3) +
      ' 容忍 ' + fmt(tolerance, unit),
  }
}

/**
 * 纯判定函数：输入 quality-frozen 的 JSON 报告 + 安全测试结果，输出两级门禁。
 * 不读文件、不起进程，方便 test/eval-pollution.test.mjs 直接构造红/绿场景。
 */
export function evaluateGates({ report = null, securityResults = [] } = {}) {
  const hard = []
  const quality = []
  const counts = (report && report.counts) || {}
  const dims = (report && report.dimensions) || {}

  // H1 过期身份泄漏：唯一一个「>0 即红」的质量指标。
  const identityAvailable = dims.identity && dims.identity.available === true
  const leak = report && report.metrics ? report.metrics.staleIdentityLeakRate : null
  if (!identityAvailable) {
    hard.push({
      id: 'stale-identity',
      label: '过期身份泄漏（superseded/archived）',
      ok: false,
      detail: '评测报告缺少身份维度，无法验证；按 fail-closed 处理',
    })
  } else if (!leak || typeof leak.numerator !== 'number') {
    hard.push({
      id: 'stale-identity',
      label: '过期身份泄漏（superseded/archived）',
      ok: false,
      detail: '身份维度已声明可用，但报告缺少 staleIdentityLeakRate；按 fail-closed 处理',
    })
  } else {
    hard.push({
      id: 'stale-identity',
      label: '过期身份泄漏（superseded/archived）',
      ok: leak.numerator === 0,
      detail:
        leak.numerator + ' / ' + leak.denominator + ' 条结果（阈值 0，无容忍度）',
    })
  }

  // H2 身份覆盖率：算不出来的结果不算「安全」，否则反向风险测不出来。
  const unidentified = counts.unidentifiedHits
  hard.push({
    id: 'identity-coverage',
    label: '返回结果身份可判定',
    ok: unidentified === 0,
    detail:
      unidentified === undefined
        ? '报告缺少 unidentifiedHits 计数（fail-closed）'
        : unidentified + ' 条无身份结果（阈值 0）',
  })

  // H3 判定器对齐：语料/状态表漂移时，身份维度可能静默错位。
  const problems = report && report.pollution && report.pollution.oracle ? report.pollution.oracle.problems : null
  hard.push({
    id: 'oracle-alignment',
    label: '身份判定器对齐',
    ok: Array.isArray(problems) && problems.length === 0,
    detail: !Array.isArray(problems)
      ? '报告缺少 oracle.problems（fail-closed）'
      : problems.length + ' 条对齐问题（阈值 0）',
  })

  // H4 结构注入 / 凭证泄漏：测试失败就是硬失败，没有容忍度。
  const required = ['security-attack', 'injection']
  const byName = new Map(securityResults.map((r) => [r.name, r]))
  if (securityResults.length === 0) {
    hard.push({
      id: 'security-tests',
      label: '结构注入 / 凭证泄漏安全测试',
      ok: false,
      detail: '没有运行安全测试（fail-closed）',
    })
  } else {
    for (const name of required) {
      const r = byName.get(name)
      hard.push({
        id: 'security:' + name,
        label: '安全测试 ' + name,
        ok: Boolean(r && r.ok),
        detail: !r ? '未运行' : r.ok ? '通过' : '失败' + (r.detail ? '：' + r.detail : ''),
      })
    }
  }

  // Q1-Q5 质量门禁（有容忍度）。
  quality.push(
    qualityRow({
      id: 'recall1',
      label: 'Recall@1',
      current: metricPercent(report, 'recallAt1'),
      baseline: BASELINE.recall1,
      tolerance: TOLERANCE.recall1,
      higherBetter: true,
      unit: '%',
    }),
  )
  quality.push(
    qualityRow({
      id: 'recall3',
      label: 'Recall@3',
      current: metricPercent(report, 'recallAt3'),
      baseline: BASELINE.recall3,
      tolerance: TOLERANCE.recall3,
      higherBetter: true,
      unit: '%',
    }),
  )
  quality.push(
    qualityRow({
      id: 'mrr',
      label: 'MRR',
      current: report && report.metrics && report.metrics.mrr ? report.metrics.mrr.value : null,
      baseline: BASELINE.mrr,
      tolerance: TOLERANCE.mrr,
      higherBetter: true,
    }),
  )
  quality.push(
    qualityRow({
      id: 'noAnswerFp',
      label: '无答案误召率',
      current: metricPercent(report, 'noAnswerFpRate'),
      baseline: BASELINE.noAnswerFp,
      tolerance: TOLERANCE.noAnswerFp,
      higherBetter: false,
      unit: '%',
    }),
  )
  quality.push(
    qualityRow({
      id: 'contentPollution',
      label: '内容污染率（按身份）',
      current: metricPercent(report, 'contentPollutionRate'),
      baseline: BASELINE.contentPollution,
      tolerance: TOLERANCE.contentPollution,
      higherBetter: false,
      unit: '%',
    }),
  )
  quality.push(
    qualityRow({
      id: 'latencyP95',
      label: 'Recall p95 延迟',
      current: report && report.latency ? report.latency.p95Ms : null,
      baseline: BASELINE.latencyP95,
      tolerance: TOLERANCE.latencyP95,
      higherBetter: false,
      unit: 'ms',
    }),
  )

  return {
    hard: { ok: hard.every((r) => r.ok), rows: hard },
    quality: { ok: quality.every((r) => r.ok), rows: quality },
  }
}

/** 退出码约定：0 全绿 / 1 仅质量门禁失败 / 2 硬安全门禁失败。 */
export function exitCodeFor(gates) {
  if (!gates.hard.ok) return 2
  if (!gates.quality.ok) return 1
  return 0
}

export function formatGateReport(gates, report = null) {
  const lines = []
  lines.push('=== 冻结集质量回归检测（两级门禁）===')
  lines.push('')
  lines.push('--- 第 1 级：硬安全门禁（无容忍度；任一条失败 → 退出码 2）---')
  for (const row of gates.hard.rows) {
    lines.push((row.ok ? 'ok   ' : 'FAIL ') + pad(row.label, 34) + ' ' + row.detail)
  }
  lines.push('')
  lines.push('--- 第 2 级：质量门禁（容忍度检查；失败 → 退出码 1）---')
  for (const row of gates.quality.rows) {
    lines.push((row.ok ? 'ok   ' : 'FAIL ') + pad(row.label, 34) + ' ' + row.detail)
  }

  if (report) {
    const legacyQuery = metricPercent(report, 'staleQueryRate')
    const legacyHit = metricPercent(report, 'staleHitShare')
    const falsePositives =
      report.pollutionAudit && Array.isArray(report.pollutionAudit.adjudicatedFalsePositives)
        ? report.pollutionAudit.adjudicatedFalsePositives.length
        : 0
    lines.push('')
    lines.push('--- 旧口径观察（不进任何门禁）---')
    lines.push(
      '旧·污染查询率 ' + fmt(legacyQuery, '%') +
        ' | 旧·污染结果占比 ' + fmt(legacyHit, '%') +
        ' | 旧口径误报 ' + falsePositives + ' 条（正确新条目引用旧词）',
    )
  }

  lines.push('')
  lines.push(
    '结论: 硬安全门禁 ' + (gates.hard.ok ? '通过' : '失败') +
      ' | 质量门禁 ' + (gates.quality.ok ? '通过' : '失败'),
  )
  return lines.join('\n')
}

function runNode(relPath, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(root, relPath), ...args], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err) {
    return {
      ok: false,
      stdout: String((err && err.stdout) || ''),
      stderr: String((err && err.stderr) || ''),
    }
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-'))
  const reportPath = path.join(tmp, 'quality-frozen.json')

  const frozen = runNode('scripts/quality-frozen.mjs', ['--json', reportPath])
  let report = null
  if (frozen.ok) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    } catch (err) {
      console.error('冻结集 JSON 报告读不出来：' + err.message)
    }
  }

  // 安全测试独立跑：即使指标脚本挂了，也要先把「结构注入 / 凭证泄漏」的结论拿到。
  const securityResults = [
    { name: 'security-attack', path: 'test/security-attack.test.mjs' },
    { name: 'injection', path: 'test/injection.test.mjs' },
  ].map(({ name, path: p }) => {
    const result = runNode(p)
    if (!result.ok) {
      console.error('\n[硬安全] 安全测试失败: ' + p)
      console.error((result.stdout + '\n' + result.stderr).trim().slice(-2000))
      const firstError = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
      return { name, ok: false, detail: firstError.slice(0, 300) }
    }
    return { name, ok: true }
  })

  if (!frozen.ok) {
    console.error('\n[硬安全] 冻结集评测执行失败（完整性校验/崩溃），本次数字不能当基线：')
    console.error((frozen.stdout + '\n' + frozen.stderr).trim().slice(-3000))
  }

  const gates = evaluateGates({ report, securityResults })
  console.log(formatGateReport(gates, report))

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}

  const code = exitCodeFor(gates)
  if (code === 2) {
    console.error('\n[硬安全门禁失败] 这一类没有容忍度：过期身份泄漏 / 身份不可判定 / 判定器错位 / 安全测试失败。')
    process.exit(2)
  }
  if (code === 1) {
    console.error('\n[质量门禁失败] 召回/误召/内容污染/延迟退化超过容忍度。')
    console.error('如果这是有意的取舍，改 BASELINE 或 TOLERANCE 并说明原因，别悄悄放过。')
    process.exit(1)
  }

  console.log('\n两级门禁全部通过（注意：这不等于质量好，只等于没变坏、且没有已知安全泄漏）')
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase()

if (isMain) main()
