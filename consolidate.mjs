import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

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

/**
 * 按标题切小节，并向下继承最近的日期标题。
 *
 * 对话记录的结构是「## 2026-10-22」下面挂若干「### 小节」。
 * 日期必须从这两层结构里取 —— 用运行当天做 event_time 的话，
 * 昨天记的事今天重跑一次就变成「刚发生」，时间衰减全乱。
 */
export function sections(text) {
  const out = []
  const parts = text.split(/\n(?=#{2,3} )/)
  let line = 1
  let currentDate = null
  for (const p of parts) {
    const t = p.trim()
    const adv = p.split('\n').length
    const head = t.split('\n')[0] || ''
    const m = head.match(/^##\s+(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/)
    if (m) currentDate = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    if (t.length >= 40) out.push({ line, text: t, date: currentDate })
    line += adv
  }
  return out
}

export function idOf(text) {
  return 'mem-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/**
 * 固化：把对话小节写成 structured.jsonl。
 *
 * 只依赖入参，不读环境变量、不猜作者本机目录 —— 换一台机器、进测试用临时目录都能直接调用。
 * 路径齐全但文件不存在时直接抛错：静默当成空对话继续跑，会让人以为固化成功了。
 */
export function consolidate({ dialogueFile, outputFile, watermarkFile, now = new Date() }) {
  for (const [name, value] of Object.entries({ dialogueFile, outputFile, watermarkFile })) {
    if (!value) throw new Error(`consolidate: 缺少 ${name}`)
  }
  if (!fs.existsSync(dialogueFile)) {
    throw new Error(`consolidate: 对话文件不存在 ${dialogueFile}`)
  }

  const source = fs.readFileSync(dialogueFile, 'utf8')
  const wm = readJson(watermarkFile, { ids: [] })
  const processed = new Set(Array.isArray(wm.ids) ? wm.ids : [])
  const all = sections(source)

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
      event_time: s.date || now.toISOString().slice(0, 10),
      source_id: 'dialogue:' + s.line,
      quote,
      status: 'active',
      supersedes: null,
      created_at: now.toISOString(),
      // 规则抽取（标题当事实）不产生可信度估计。写死 1.0 会把「切分成功」
      // 伪装成「事实已确定」，这里如实留空，等真做了 LLM 抽取再填。
      confidence: null,
    })
    processed.add(id)
  }

  const existing = readText(outputFile)
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
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
    fs.appendFileSync(outputFile, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  }

  // 水位目录也要建：之前写死路径时这里可能不存在，写完的记录下次会被当成没处理过
  fs.mkdirSync(path.dirname(watermarkFile), { recursive: true })
  fs.writeFileSync(watermarkFile, JSON.stringify({ ids: [...processed], updatedAt: now.toISOString() }, null, 2), 'utf8')

  return {
    pending: pending.length,
    written: fresh.length,
    total: existing.length + fresh.length,
    watermark: processed.size,
  }
}

/** 从当前目录往上找「对话记录.md」，最多 4 层。 */
function findDialogue(start = process.cwd()) {
  let dir = start
  for (let i = 0; i < 4; i += 1) {
    if (fs.existsSync(path.join(dir, '对话记录.md'))) return path.join(dir, '对话记录.md')
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** CLI 的路径解析：环境变量优先，其次向上找，最后明确报错。 */
export function resolveCliPaths(env = process.env, cwd = process.cwd()) {
  const dialogueFile = env.DSH_MEMORY_DIALOGUE || findDialogue(cwd)
  if (!dialogueFile) {
    throw new Error(
      'consolidate: 找不到对话记录。设置 DSH_MEMORY_DIALOGUE 指向对话文件，或在含「对话记录.md」的目录下运行。',
    )
  }
  const base = env.DSH_MEMORY_ROOT || path.join(path.dirname(dialogueFile), 'memory')
  return {
    dialogueFile,
    outputFile: env.DSH_MEMORY_STRUCTURED || path.join(base, '记忆', 'structured.jsonl'),
    watermarkFile: env.DSH_MEMORY_WATERMARK || path.join(base, '记忆', '.watermark.json'),
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase()

if (isMain) {
  try {
    const paths = resolveCliPaths()
    console.log('dialogue: ', paths.dialogueFile)
    console.log('output:   ', paths.outputFile)
    console.log('watermark:', paths.watermarkFile)
    const r = consolidate(paths)
    console.log('pending sections:', r.pending)
    console.log('written:', r.written)
    console.log('total records:', r.total)
    console.log('watermark ids:', r.watermark)
  } catch (error) {
    console.error(String((error && error.message) || error))
    process.exit(1)
  }
}
