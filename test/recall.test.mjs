import fs from 'node:fs'

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
    const advance = part.split('\n').length
    if (t.length >= 40 && !/^\|/.test(t.split('\n')[1] || '')) {
      out.push({ id: src + ':' + line, src, line, text: t })
    }
    line += advance
  }
  return out
}

const root = 'D:/dsh-workspace/memory'
const entries = [
  ...splitEntries(readText('D:/dsh-workspace/对话记录.md'), 'dialogue'),
  ...splitEntries(readText(root + '/日记.md'), 'diary'),
  ...splitEntries(readText(root + '/生长/状态.md'), 'state'),
]

function buildIdf(es) {
  const df = new Map()
  for (const e of es) for (const g of new Set(grams(e.text))) df.set(g, (df.get(g) || 0) + 1)
  const N = Math.max(1, es.length)
  const idf = new Map()
  for (const [g, n] of df) idf.set(g, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  return idf
}
const idf = buildIdf(entries)

function scoreEntry(queryGrams, entry) {
  const tf = new Map()
  for (const g of grams(entry.text)) tf.set(g, (tf.get(g) || 0) + 1)
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
  return { score: score / Math.sqrt(Math.max(1, entry.text.length)), coverage }
}

function recall(query, topK = 3) {
  const qg = [...new Set(grams(query))]
  if (!qg.length) return []
  const hits = []
  for (const e of entries) {
    const s = scoreEntry(qg, e)
    if (s.score > 0) hits.push({ entry: e, ...s })
  }
  hits.sort((a, b) => b.score - a.score)
  if (!hits.length) return []
  const floor = Math.max(0.02, hits[0].score * 0.3)
  return hits.filter((h) => h.score >= floor && h.coverage >= 0.15).slice(0, topK)
}

for (const q of ['按顺序开发啊，现在功能完全实现了吗', '大肥鱼', '记忆档案', 'QQ 机器人', 'zzzz乱码']) {
  const r = recall(q)
  console.log('Q:', q, '=>', r.length, 'hits')
  for (const h of r) console.log('   ', h.entry.id, 'score', h.score.toFixed(3), 'cov', h.coverage.toFixed(2), '|', h.entry.text.slice(0, 40).replace(/\s+/g, ' '))
}
