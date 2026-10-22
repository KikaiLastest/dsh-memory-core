import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixtures = path.join(root, 'test', 'fixtures')
const files = fs.readdirSync(fixtures).filter((f) => /^frozen-.*\.json$/.test(f)).sort()
const cases = []
for (const file of files) {
  for (const c of JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'))) cases.push({ ...c, scene: file.replace(/^frozen-/, '').replace(/\.json$/, '') })
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
fs.copyFileSync(path.join(fixtures, 'frozen-corpus.md'), dialogueFile)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const SUP = new Set(['数据库选型', '部署位置', '代码风格', '编辑器'])
fs.writeFileSync(structuredFile, recs.filter((r) => r.fact !== '冻结评测语料').map((r) => (SUP.has(r.fact) ? { ...r, status: 'superseded' } : r)).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const cfg = { memoryRoot, dialogueFile, structuredFile, topK: 3, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30 }

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
const bigrams = (s) => { const t = norm(s); const o = []; for (let i = 0; i < t.length - 1; i++) o.push(t.slice(i, i + 2)); return o }
const clauses = (s) => String(s || '').split(/[。！？；\n，、：,;!?:]+/).map((x) => norm(x)).filter(Boolean)
const FOCUS = ['牌子','品牌','型号','版本','端口','路径','目录','地址','名字','叫什么','多少','几个','几号','哪','谁','为什么','怎么','如何','是不是','有没有','区别','多大','多久','什么']
const ATTR = new Set(['牌子','品牌','型号','版本','端口','路径','地址','编号','ip','大小','数量','时间','价格','名字'])
const VALUE = /\d|[A-Z]{2,}|[a-z]+\/|[\\/][\w.-]+|["“”'‘’「」]/

function features(q, hit) {
  const g = [...new Set(bigrams(q))]
  const text = norm(hit.entry.text)
  const cs = clauses(hit.entry.text)
  const inClause = cs.map((c) => g.filter((x) => c.includes(x)).length)
  const bestClauseShare = cs.length ? Math.max(...inClause) / g.length : 0
  const bestClauseCount = cs.length ? Math.max(...inClause) : 0
  const matchedInText = g.filter((x) => text.includes(x))
  // 分散度：命中的 gram 落在几个子句里
  const hitsPerClause = cs.filter((c) => matchedInText.some((x) => c.includes(x))).length
  const focus = FOCUS.filter((w) => norm(q).includes(norm(w)))
  const focusIn = focus.filter((w) => text.includes(norm(w)))
  const latin = (String(q).match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g) || []).map((x) => x.toLowerCase())
  const latinIn = latin.filter((w) => text.includes(w))
  const attr = [...ATTR].filter((w) => norm(q).includes(w))
  const attrHit = attr.filter((w) => text.includes(w))
  const valueShape = VALUE.test(hit.entry.text)
  return { q, g: g.length, matched: hit.queryMatched, cov: +hit.coverage.toFixed(2), bestClauseShare: +bestClauseShare.toFixed(2), bestClauseCount, clauses: cs.length, disp: hitsPerClause, focus: focus.join('|'), focusIn: focusIn.join('|'), latin: latin.join('|'), latinIn: latinIn.join('|'), attr: attr.join('|'), attrHit: attrHit.join('|'), valueShape, verdict: hit.__v }
}

const rows = { accept: [], noansAccepted: [] }
for (const c of cases) {
  const r = recallWithVerdict({ ...cfg, topK: 3 }, c.q, Date.now() + 5000)
  if (!r.hits.length) continue
  const f = features(c.q, { ...r.hits[0], __v: r.verdict, entry: r.hits[0].entry })
  if (c.expect == null && r.verdict === 'answer') rows.noansAccepted.push(f)
  else if (c.expect != null && r.verdict !== 'abstain') { f.expect = c.expect; f.rank1 = r.hits[0].entry.text.includes(c.expect); rows.accept.push(f) }
}
console.log('=== 无答案幸存的 ' + rows.noansAccepted.length + ' 条 ===')
for (const f of rows.noansAccepted) console.log(JSON.stringify(f))
console.log('\n=== 有答案且当前不拒答的 ' + rows.accept.length + ' 条（按 bestClauseShare 升序）===')
rows.accept.sort((a, b) => a.bestClauseShare - b.bestClauseShare)
for (const f of rows.accept) console.log(JSON.stringify(f))
fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify(rows, null, 2))
console.log('\nOUT ' + path.join(dir, 'features.json'))
