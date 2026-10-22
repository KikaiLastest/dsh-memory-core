import fs from 'node:fs'
import path from 'node:path'
import { recall as prodRecall } from '../index.js'

const STOP = new Set([
  '用户', '我的', '什么', '怎么', '这个', '那个', '就是', '还是', '可以', '已经',
  '一个', '不是', '没有', '我们', '你们', '他们', '现在', '然后', '因为', '所以',
])

function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase() }
function grams(s) {
  const t = norm(s)
  const out = []
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2))
  return out
}
function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

function splitEntries(text, src) {
  const out = []
  const parts = text.split(/\n(?=#{2,3} )/)
  let line = 1
  for (const part of parts) {
    const t = part.trim()
    const adv = part.split('\n').length
    if (t.length >= 40 && !/^\|/.test(t.split('\n')[1] || '')) out.push({ id: src + ':' + line, src, line, text: t })
    line += adv
  }
  return out
}

// 路径走环境变量，换机器不用改源码；都没有就报错退出，不许算出一堆 NaN 还报绿。
// 另外从当前目录向上找一层：在插件目录里跑 npm test 时，档案其实在工作区根上。
function findUp(name, start = process.cwd()) {
  let dir = start
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const root =
  process.env.DSH_MEMORY_ROOT || findUp('memory') || path.join(process.cwd(), 'memory')
const dialogueFile =
  process.env.DSH_MEMORY_DIALOGUE || findUp('对话记录.md') || path.join(process.cwd(), '对话记录.md')
const entries = [
  ...splitEntries(readText(dialogueFile), 'dialogue'),
  ...splitEntries(readText(path.join(root, '日记.md')), 'diary'),
  ...splitEntries(readText(path.join(root, '生长', '状态.md')), 'state'),
]

const byId = new Map()
const gramIndex = new Map()
const df = new Map()
for (const e of entries) {
  const gs = grams(e.text)
  const tf = new Map()
  for (const g of gs) tf.set(g, (tf.get(g) || 0) + 1)
  e.tf = tf
  byId.set(e.id, e)
  for (const g of new Set(gs)) {
    df.set(g, (df.get(g) || 0) + 1)
    let set = gramIndex.get(g)
    if (!set) {
      set = new Set()
      gramIndex.set(g, set)
    }
    set.add(e.id)
  }
}
const N = Math.max(1, entries.length)
const idf = new Map()
for (const [g, n] of df) idf.set(g, Math.log(1 + (N - n + 0.5) / (n + 0.5)))

function overlap(queryGrams, entry) {
  const tf = entry.tf
  let matched = 0, total = 0
  for (const g of queryGrams) {
    if (STOP.has(g)) continue
    total += 1
    if ((tf.get(g) || 0) > 0) matched += 1
  }
  return total === 0 ? 0 : matched / total
}

function bm25(queryGrams, entry) {
  const tf = entry.tf
  let score = 0, matched = 0, total = 0
  for (const g of queryGrams) {
    if (STOP.has(g)) continue
    total += 1
    const f = tf.get(g) || 0
    if (f === 0) continue
    matched += 1
    score += (idf.get(g) || 1) * ((f * 2.2) / (f + 1.2))
  }
  const coverage = total === 0 ? 0 : matched / total
  return { score: score / Math.sqrt(Math.max(1, entry.text.length)), coverage, matched }
}

function recallA(q, topK = 3) {
  const qg = [...new Set(grams(q))]
  const hits = entries.map((e) => ({ entry: e, score: overlap(qg, e) })).filter((h) => h.score > 0)
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

function recallB(q, topK = 3) {
  const qg = [...new Set(grams(q))]
  const hits = []
  for (const e of entries) {
    const s = bm25(qg, e)
    if (s.score > 0) hits.push({ entry: e, ...s })
  }
  hits.sort((a, b) => b.score - a.score)
  if (!hits.length) return []
  const floor = Math.max(0.02, hits[0].score * 0.3)
  return hits.filter((h) => h.score >= floor && h.coverage >= 0.2 && h.matched >= 2).slice(0, topK)
}

function recallC(q, topK = 3) {
  const qg = [...new Set(grams(q))]
  const cand = new Set()
  for (const g of qg) {
    const ids = gramIndex.get(g)
    if (ids) for (const id of ids) cand.add(id)
  }
  const pool = cand.size ? [...cand].map((id) => byId.get(id)) : entries
  const hits = []
  for (const e of pool) {
    const s = bm25(qg, e)
    if (s.score > 0) hits.push({ entry: e, ...s })
  }
  hits.sort((a, b) => b.score - a.score)
  if (!hits.length) return []
  const floor = Math.max(0.02, hits[0].score * 0.3)
  return hits.filter((h) => h.score >= floor && h.coverage >= 0.2 && h.matched >= 2).slice(0, topK)
}

const positives = entries
  .map((e) => ({ q: (e.text.split('\n')[0] || '').replace(/^#+\s*/, '').trim(), expect: e.id }))
  .filter((x) => x.q.length >= 3)
const negatives = ['今天天气不错', '你吃了吗', '晚安', '哈哈', '在吗', '帮我订个外卖', '明天几点开会', '推荐部电影', '你几岁了', '无聊死了']
const distractors = ['react useEffect 依赖数组', 'magpie 网关 429', 'electron 透明窗 置顶', 'pnpm overrides 版本错位', 'qqbot appid 沙箱']

function evaluate(fn, name) {
  let h1 = 0, h3 = 0
  const t0 = Date.now()
  for (const p of positives) {
    const r = fn(p.q)
    const ids = r.map((h) => h.entry.id)
    if (ids[0] === p.expect) h1 += 1
    if (ids.includes(p.expect)) h3 += 1
  }
  const ms = Date.now() - t0
  let negHits = 0
  const negDetail = []
  for (const q of negatives) {
    const r = fn(q)
    if (r.length > 0) {
      negHits += 1
      negDetail.push(q + ' -> ' + r.map((h) => h.entry.id + ':' + h.score.toFixed(3)).join(','))
    }
  }
  const distHits = distractors.map((q) => fn(q).length)
  console.log(
    name.padEnd(2),
    '| rec@1', ((h1 / positives.length) * 100).toFixed(1) + '%',
    '| rec@3', ((h3 / positives.length) * 100).toFixed(1) + '%',
    '| 误召', negHits + '/' + negatives.length,
    '| 干扰命中', JSON.stringify(distHits),
    '|', ms + 'ms',
  )
  for (const d of negDetail) console.log('     ', d)
  return {
    rec1: positives.length ? h1 / positives.length : 0,
    rec3: positives.length ? h3 / positives.length : 0,
    negHits,
    ms,
  }
}

// 没有语料就明确失败。以前这里会算成 0/0 = NaN，打印一排 NaN% 然后 exit 0，
// 于是「测试全绿」变成一句空话 —— 在别人机器上它压根没测任何东西。
if (entries.length === 0 || positives.length === 0) {
  console.error(
    `eval: 没有可用语料（entries=${entries.length}, positives=${positives.length}）。\n` +
      '设置 DSH_MEMORY_ROOT / DSH_MEMORY_DIALOGUE，或在含「对话记录.md」的目录下运行。',
  )
  process.exit(1)
}

console.log('entries:', entries.length, '| positives:', positives.length)
evaluate(recallA, 'A')
evaluate(recallB, 'B')
evaluate(recallC, 'C')

// P 组才是生产实现：直接调 index.js 的 recall。前面三组只是实验对照，不算数。
const prodCfg = {
  dialogueFile,
  memoryRoot: root,
  structuredFile: process.env.DSH_MEMORY_STRUCTURED || path.join(root, '记忆', 'structured.jsonl'),
  autocaptureStore: process.env.DSH_MEMORY_AUTOCAPTURE || null,
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}
const recallProd = (q, topK = 3) => prodRecall({ ...prodCfg, topK }, q, Date.now() + 1000)
const prod = evaluate(recallProd, 'P')

if (!Number.isFinite(prod.rec1) || prod.rec1 < 0.5) {
  console.error(`eval: 生产实现 rec@1 = ${(prod.rec1 * 100).toFixed(1)}%，低于 50% 底线。`)
  process.exit(1)
}
