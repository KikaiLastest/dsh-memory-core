import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIALOGUE = 'D:/dsh-workspace/对话记录.md'
const OUT = 'D:/dsh-workspace/memory/记忆/structured.jsonl'
const WM = 'D:/dsh-workspace/impl-a/.watermark.json'

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return d
  }
}

function sections(text) {
  const out = []
  const parts = text.split(/\n(?=#{2,3} )/)
  let line = 1
  for (const p of parts) {
    const t = p.trim()
    const adv = p.split('\n').length
    if (t.length >= 40) out.push({ line, text: t })
    line += adv
  }
  return out
}

const source = readText(DIALOGUE)
const wm = readJson(WM, { ids: [] })
const processed = new Set(Array.isArray(wm.ids) ? wm.ids : [])
const all = sections(source)

function idOf(text) {
  return 'mem-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

const pending = all.filter((s) => !processed.has(idOf(s.text)))

const records = []

for (const s of pending) {
  const title = (s.text.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
  const quote = s.text.slice(0, 200)
  if (!source.includes(quote)) continue // 引文必须能在原文里逐字找到
  const id = idOf(s.text)
  records.push({
    id,
    type: 'event',
    subject: '大肥鱼',
    fact: title,
    event_time: new Date().toISOString().slice(0, 10),
    source_id: 'dialogue:' + s.line,
    quote,
    status: 'active',
    supersedes: null,
    created_at: new Date().toISOString(),
    confidence: 1.0,
  })
  processed.add(id)
}

const existing = readText(OUT)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)
const seen = new Set(existing.map((e) => e.id))
const fresh = records.filter((e) => !seen.has(e.id))

if (fresh.length) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.appendFileSync(OUT, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}
fs.writeFileSync(WM, JSON.stringify({ ids: [...processed], updatedAt: new Date().toISOString() }, null, 2), 'utf8')

console.log('pending sections:', pending.length)
console.log('written:', fresh.length)
console.log('total records:', existing.length + fresh.length)
console.log('watermark ids:', processed.size)
