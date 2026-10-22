#!/usr/bin/env node
// 冻结集质量回归检测。
//
// 这个脚本不追涨——Recall@1 现在是 48.1%，硬要求它涨只会逼人去调参或改标签。
// 它只做一件事：**明显退化就把 CI 弄红**。
//
// 基线取自 BASELINE.md（commit c1fa1596 的实测值）。
// 基线变了必须同步改这里，并且说明为什么变。

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// 冻结基线（BASELINE.md 记录）
const BASELINE = {
  recall1: 48.1,
  recall3: 49.6,
  mrr: 0.489,
  noAnswerFp: 8.3, // 越低越好
  contaminated: 1.9, // 越低越好
  staleLeak: 3.3, // 越低越好
}

// 允许的退化幅度。定得宽一点是有意的：
// 宁可漏报一次小退化，也不要让 CI 因为浮点抖动天天红。
const TOLERANCE = {
  recall1: 2.0,
  recall3: 2.0,
  mrr: 0.03,
  noAnswerFp: 2.0,
  contaminated: 2.0,
  staleLeak: 2.0,
}

let out
try {
  out = execFileSync(process.execPath, [path.join(here, 'quality-frozen.mjs')], {
    encoding: 'utf8',
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) {
  // 脚本自己非零退出（语料缺失、样例对不上）——这本身就是失败，不要吞。
  console.error('冻结集脚本执行失败：')
  console.error(String(err.stdout || '').slice(0, 2000))
  console.error(String(err.stderr || '').slice(0, 2000))
  process.exit(1)
}

const pick = (re, label) => {
  const m = out.match(re)
  if (m === null) {
    console.error('解析不出「' + label + '」，评测脚本的输出格式变了。')
    console.error(out.slice(0, 1200))
    process.exit(1)
  }
  return Number(m[1])
}

const now = {
  recall1: pick(/Recall@1\s*:\s*([\d.]+)%/, 'Recall@1'),
  recall3: pick(/Recall@3\s*:\s*([\d.]+)%/, 'Recall@3'),
  mrr: pick(/MRR\s*:\s*([\d.]+)/, 'MRR'),
  noAnswerFp: pick(/无答案误召率\s*:\s*([\d.]+)%/, '无答案误召率'),
  contaminated: pick(/受污染查询比例\s*:\s*([\d.]+)%/, '受污染查询比例'),
  staleLeak: pick(/过期结果占比\s*:\s*([\d.]+)%/, '过期结果占比'),
}

const fails = []
const rows = []
for (const key of Object.keys(BASELINE)) {
  const base = BASELINE[key]
  const cur = now[key]
  // 方向：召回类越大越好，错误率类越小越好
  const higherBetter = key === 'recall1' || key === 'recall3' || key === 'mrr'
  const delta = cur - base
  const loss = higherBetter ? -delta : delta
  const bad = loss > TOLERANCE[key]
  rows.push(
    (bad ? 'FAIL ' : 'ok   ') +
      key.padEnd(14) +
      ' 基线 ' + String(base).padEnd(7) +
      ' 当前 ' + String(cur).padEnd(7) +
      ' 退化 ' + (delta >= 0 ? '+' : '') + delta.toFixed(3) +
      ' 容忍 ' + TOLERANCE[key],
  )
  if (bad) fails.push(key + ' 退化 ' + loss.toFixed(3) + '，超过容忍 ' + TOLERANCE[key])
}

console.log('=== 冻结集质量回归检测 ===')
console.log(rows.join('\n'))

if (fails.length > 0) {
  console.error('\n质量回归：')
  for (const f of fails) console.error('  - ' + f)
  console.error('\n如果这是有意的取舍，改 BASELINE 或 TOLERANCE 并说明原因，别悄悄放过。')
  process.exit(1)
}

console.log('\n没有明显退化（注意：这不等于质量好，只等于没变坏）')
