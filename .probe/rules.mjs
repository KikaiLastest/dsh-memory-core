import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixtures = path.join(root, 'test', 'fixtures')
const cases = []
for (const file of fs.readdirSync(fixtures).filter((f) => /^frozen-.*\.json$/.test(f)).sort()) {
  for (const c of JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'))) cases.push({ ...c, scene: file.replace(/^frozen-/, '').replace(/\.json$/, '') })
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
const memoryRoot = path.join(dir, 'memory')
const sd = path.join(memoryRoot, '记忆')
fs.mkdirSync(sd, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(sd, 'structured.jsonl')
const watermarkFile = path.join(sd, '.watermark.json')
fs.copyFileSync(path.join(fixtures, 'frozen-corpus.md'), dialogueFile)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const recs = fs.readFileSync(structuredFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const SUP = new Set(['数据库选型', '部署位置', '代码风格', '编辑器'])
fs.writeFileSync(structuredFile, recs.filter((r) => r.fact !== '冻结评测语料').map((r) => (SUP.has(r.fact) ? { ...r, status: 'superseded' } : r)).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const cfg = { memoryRoot, dialogueFile, structuredFile, topK: 3, minCoverage: 0.2, minMatched: 2, minRatio: 0.3, halfLifeDays: 30 }

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
const bigrams = (s) => { const t = norm(s); const o = []; for (let i = 0; i < t.length - 1; i++) o.push(t.slice(i, i + 2)); return o }
const clauses = (s) => String(s || '').split(/[。！？；\n，、：,;!?:]+/).map((x) => norm(x)).filter(Boolean)
const CJK_NUM = /[一二三四五六七八九十百千万亿两半]/
const VALUE_B = /[a-z]{2,}|\d|[\\/][\w.-]+|["“”'‘’「」]/
const ATTRS = [
  { w: '牌子', kind: 'B' }, { w: '品牌', kind: 'B' }, { w: '型号', kind: 'B' }, { w: '版本', kind: 'B' },
  { w: '端口', kind: 'B' }, { w: '路径', kind: 'B' }, { w: '目录', kind: 'B' }, { w: '地址', kind: 'B' },
  { w: '编号', kind: 'B' }, { w: '名字', kind: 'B' }, { w: '叫', kind: 'B' },
  { w: '多少', kind: 'A' }, { w: '几个', kind: 'A' }, { w: '几集', kind: 'A' }, { w: '几点', kind: 'A' },
  { w: '多久', kind: 'A' }, { w: '多大', kind: 'A' }, { w: '几岁', kind: 'A' }, { w: '什么时候', kind: 'A' },
]
function check(q, hit) {
  const text = norm(hit.entry.text)
  const qn = norm(q)
  const cs = clauses(hit.entry.text)
  const g = [...new Set(bigrams(q))]
  let best = null, bestN = -1
  for (const c of cs) { const n = g.filter((x) => c.includes(x)).length; if (n > bestN) { bestN = n; best = c } }
  const attr = ATTRS.find((a) => qn.includes(a.w))
  let attrFail = false
  if (attr && best != null) {
    const attrInClause = best.includes(attr.w === '叫' ? '叫' : attr.w)
    const valueOk = attr.kind === 'A' ? (CJK_NUM.test(best) || /\d/.test(best) || VALUE_B.test(best)) : VALUE_B.test(best)
    attrFail = !attrInClause && !valueOk
  }
  const latin = (String(q).match(/[A-Za-z][A-Za-z0-9_+.-]{1,}/g) || []).map((x) => x.toLowerCase()).filter((x) => !/^(the|and|for|with|how|what)$/.test(x))
  const latinMiss = latin.filter((w) => !text.includes(w))
  return { attr: attr ? attr.w : null, attrFail, latin, latinMiss, clause: best }
}
const rows = []
for (const c of cases) {
  const r = recallWithVerdict({ ...cfg, topK: 3 }, c.q, Date.now() + 5000)
  if (!r.hits.length) continue
  const v = check(c.q, r.hits[0])
  rows.push({ q: c.q, expect: c.expect, scene: c.scene, verdict: r.verdict, rank1: c.expect == null ? null : r.hits[0].entry.text.includes(c.expect), ...v })
}
const live = rows.filter((r) => r.verdict !== 'abstain')
const fires = live.filter((r) => r.attrFail || r.latinMiss.length)
console.log('当前不拒答（answer+ambiguous）: ' + live.length + '，新规则会打掉: ' + fires.length)
console.log('  其中打掉有答案的（误拒）: ' + fires.filter((r) => r.expect != null).length)
console.log('  其中打掉无答案的（正解）: ' + fires.filter((r) => r.expect == null).length)
console.log('\n--- 打掉的有答案样本 ---')
for (const r of fires.filter((x) => x.expect != null)) console.log(JSON.stringify({ q: r.q, expect: r.expect, attr: r.attr, attrFail: r.attrFail, latinMiss: r.latinMiss, clause: r.clause, rank1: r.rank1 }))
console.log('\n--- 打掉的无答案样本 ---')
for (const r of fires.filter((x) => x.expect == null)) console.log(JSON.stringify({ q: r.q, attr: r.attr, attrFail: r.attrFail, latinMiss: r.latinMiss, clause: r.clause }))
console.log('\n--- 两条红队样本的明细 ---')
for (const r of rows.filter((x) => x.q.includes('牌子') || x.q.includes('GIL'))) console.log(JSON.stringify(r))
const missAttr = rows.filter((r) => r.attr && !r.attrFail)
console.log('\n属性词出现且未判失败的样本数: ' + missAttr.length)
