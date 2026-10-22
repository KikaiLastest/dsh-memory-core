/**
 * 记忆导航 + 后台总结（纯本地规则，不调 LLM）。
 *
 * 1. buildNav(cfg)：给 systemPrompt 注入一小段「档案里有什么」的导航。
 *    扫 cfg.memoryRoot 下的 md、自动捕获 JSONL、对话记录，按新鲜度列主题与最近几条的一行摘要 + 关键词。
 *    总长度硬限制（默认 600 字，按新鲜度截断）；一条记忆都没有时返回空串（调用方据此不注入）。
 *
 * 2. summarizeDialogue(cfg)：后台把空闲的对话记录摘成条目，追加到独立 JSONL。
 *    - 对话文件 mtime 超过 summarizeIdleMinutes 没变才算空闲
 *    - 按内容 hash + 已处理小节 key 记录水位，重复跑不会重复写
 *    - 只抽「标题 + 首句」，首句截断；不调模型
 *    - 写入前走 sanitize（enableSanitize 可关）
 *
 * 这里的「记忆」只读：不写 memory/，所有产物落在 cfg.summaryStore（默认 ~/.dsh/autocapture/summaries.jsonl）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readCaptureStore } from './autocapture.mjs'
import { sanitize } from './sanitize.mjs'
import { idOf, loadStatusMap, isRecallable, resolveEntryStatus } from './status.mjs'
import { assertSafeWritePath, atomicWriteJson, realPathish } from './fs-safe.mjs'

const MAX_MD_BYTES = 512 * 1024
const MAX_SEEN = 5000
const MAX_NAV_ENTRIES = 8

/** 中文 2-gram 里没信息量的片段（和召回那边保持同一套口味，另补几个摘要常用词）。 */
const STOP = new Set([
  '用户', '我的', '什么', '怎么', '这个', '那个', '就是', '还是', '可以', '已经',
  '一个', '不是', '没有', '我们', '你们', '他们', '现在', '然后', '因为', '所以',
  '这些', '那些', '一下', '以及', '并且', '如果', '但是', '而且', '自己', '这个',
])

/** 只有容器意义的标题，不进导航。 */
const SKIP_TITLES = new Set(['元信息', '目录', '说明', '日记', '状态', '生长记录', '对话记录', '开场'])

const SOURCE_LABEL = { dialogue: '对话', autocapture: '捕获', summary: '摘要' }

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function statOf(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeJsonAtomic(file, value) {
  atomicWriteJson(file, value)
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 从任意文本里抠出 YYYY-MM-DD；没有就返回 null。 */
function extractDate(text) {
  const m = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(text || ''))
  if (!m) return null
  const pad = (s) => String(s).padStart(2, '0')
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
}

/** `## 2026-10-22` 这种纯日期标题只当容器，不单独成条。 */
function isDateOnly(title) {
  return /^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(String(title || '').trim())
}

/** 去掉行内 Markdown 记号，留下能直接塞进提示词的一行字。 */
function stripInlineMd(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 标题清洗：去掉 `#4 ｜ 2026-10-21 ｜ 11:35 ｜ 【PC】 ｜ full` 里只描述格式的部分。
 * 清洗完什么都不剩（纯元信息标题）时，退回首句截断当主题，避免导航里出现日期占位。
 */
function cleanHeading(title, fallbackText = '') {
  const parts = String(title || '')
    .split(/[｜|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^#\d+$/.test(part))
    .filter((part) => !isDateOnly(part))
    .filter((part) => !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(part))
    .filter((part) => !/^【[^】]*】$/.test(part))
    .filter((part) => !/^(?:full|compact|short)$/i.test(part))

  let cleaned = parts.join(' · ')
  cleaned = cleaned
    .replace(/^【[^】]*】\s*/, '')
    .replace(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/^[\s·\-—]+|[\s·\-—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned) return cleaned
  const fallback = stripInlineMd(fallbackText)
  return fallback.length > 24 ? fallback.slice(0, 23) + '…' : fallback
}

/** 取正文首句（跳过表格、代码围栏、只有粗体标签的行），超长截断。 */
function firstSentence(body, maxLen = 120) {
  for (const raw of String(body || '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    if (/^[|>]/.test(line) || /^```/.test(line) || /^---+$/.test(line)) continue
    if (/^\*\*[^*]+\*\*$/.test(line)) continue
    line = line.replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
    line = stripInlineMd(line)
    line = line.replace(/^(用户|我|助手|assistant|user)\s*[:：]\s*/i, '')
    if (line.length < 4) continue
    const cut = line.search(/[。！？!?；;]/)
    if (cut >= 0) line = line.slice(0, cut + 1)
    if (line.length > maxLen) line = line.slice(0, Math.max(1, maxLen - 1)) + '…'
    return line
  }
  return ''
}

/** 标题 + 首句里挑 2-gram / 英文词当关键词，标题权重更高。 */
function keywordsOf(title, summary, limit = 3) {
  const scored = new Map()
  const add = (text, weight) => {
    const t = String(text || '')
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) {
      const word = m[0].replace(/[.]+$/, '')
      if (word.length < 3) continue
      const key = word.toLowerCase()
      scored.set(key, (scored.get(key) || 0) + weight * 2)
    }
    for (const run of t.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const gram = run.slice(i, i + 2)
        if (STOP.has(gram)) continue
        scored.set(gram, (scored.get(gram) || 0) + weight)
      }
    }
  }
  add(title, 3)
  add(summary, 1)
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key)
}

/**
 * 把 Markdown 按 `##` / `###` / `####` 切小节。
 * 返回 [{ source, title, summary, keywords, at, date, line }]；
 * 纯日期标题只更新继承日期，不产出条目。
 */
function parseMarkdown(text, source, fallbackAt = null) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  const fallbackDate = fallbackAt ? new Date(fallbackAt).toISOString().slice(0, 10) : null
  let inheritedDate = null
  let current = null

  const flush = () => {
    if (!current) return
    const summary = firstSentence(current.body.join('\n'))
    const title = cleanHeading(stripInlineMd(current.title), summary)
    if (title && summary && !SKIP_TITLES.has(title) && summary.length >= 4) {
      const date = extractDate(current.title) || inheritedDate || fallbackDate
      out.push({
        source,
        title,
        summary,
        keywords: keywordsOf(title, summary),
        at: date ? Date.parse(date + 'T00:00:00') || fallbackAt || 0 : fallbackAt || 0,
        date,
        line: current.line,
        // 小节原文。摘要记录会带上它的内容哈希，这样即使标题被改、行号漂移，
        // 召回时也能靠内容身份找到「这条记忆是不是已经被淘汰了」。
        raw: current.raw.join('\n').trim(),
      })
    }
    current = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(lines[i])
    if (match) {
      flush()
      const title = match[2]
      if (extractDate(title) && isDateOnly(title)) {
        inheritedDate = extractDate(title)
        current = null
        continue
      }
      current = { title, body: [], line: i + 1, raw: [lines[i]] }
      continue
    }
    if (current) {
      current.body.push(lines[i])
      current.raw.push(lines[i])
    }
  }
  flush()
  return out
}

/** 递归找 memoryRoot 下的 md（最多 3 层），跳过隐藏目录与大文件。 */
function listMarkdownFiles(root) {
  if (!root) return []
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full, depth + 1)
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  out.sort()
  return out
}

function sourceLabel(source) {
  if (SOURCE_LABEL[source]) return SOURCE_LABEL[source]
  return path.basename(String(source || '档案')).replace(/\.md$/i, '')
}

/** 把所有记忆源摊平成同一种条目；读不了的文件静默跳过。 */
function collectEntries(cfg, mdFiles) {
  const out = []

  for (const file of mdFiles) {
    const st = statOf(file)
    if (!st || !st.isFile() || st.size > MAX_MD_BYTES) continue
    const text = readText(file)
    if (!text) continue
    const rel = path.relative(cfg.memoryRoot || '', file).replace(/\\/g, '/').replace(/\.md$/i, '')
    out.push(...parseMarkdown(text, rel, st.mtimeMs))
  }

  if (cfg.dialogueFile) {
    const st = statOf(cfg.dialogueFile)
    if (st && st.isFile() && st.size <= MAX_MD_BYTES) {
      out.push(...parseMarkdown(readText(cfg.dialogueFile), 'dialogue', st.mtimeMs))
    }
  }

  if (cfg.autocaptureStore) {
    for (const record of readCaptureStore(cfg.autocaptureStore)) {
      const text = String((record && record.text) || '').trim()
      if (!text) continue
      // 旧存档里可能有加过滤前录进去的子代理任务提示（上千字、带 ## / 代码围栏），
      // 导航只要一句话，这类直接跳过，别把整段任务书塞进系统提示。
      if (text.length > 200 || /^##\s/m.test(text) || text.includes('```')) continue
      const summary = firstSentence(text, 80)
      if (!summary) continue
      const at = Date.parse(record.created_at || record.createdAt || '') || 0
      out.push({
        source: 'autocapture',
        title: '自动捕获',
        summary,
        keywords: keywordsOf('自动捕获', summary),
        at,
        date: at ? new Date(at).toISOString().slice(0, 10) : null,
        line: 0,
      })
    }
  }

  return out
}

const navCache = { key: '', text: undefined }

function navKey(mdFiles, cfg, maxChars, redact) {
  const files = [...mdFiles]
  if (cfg.dialogueFile) files.push(cfg.dialogueFile)
  if (cfg.autocaptureStore) files.push(cfg.autocaptureStore)
  if (cfg.structuredFile) files.push(cfg.structuredFile) // 状态变了导航要重算
  const signature = files
    .map((file) => {
      const st = statOf(file)
      return st ? `${file}:${st.mtimeMs}:${st.size}` : `${file}:0`
    })
    .join('|')
  return `${signature}|${maxChars}|${redact ? '1' : '0'}`
}

/** 测试/热更新用：丢掉导航缓存。 */
export function clearSummaryCache() {
  navCache.key = ''
  navCache.text = undefined
}

/**
 * 生成常驻记忆导航。
 * @param {object} cfg 宿主配置（memoryRoot / dialogueFile / autocaptureStore / summaryMaxChars / enableSanitize）
 * @param {{ maxChars?: number }} [options]
 * @returns {string} 没有记忆时返回 ''，否则 ≤ maxChars 的多行导航
 */
export function buildNav(cfg = {}, options = {}) {
  const maxChars = clampInt(options.maxChars ?? cfg.summaryMaxChars, 80, 2000, 600)
  const redact = cfg.enableSanitize !== false
  const mdFiles = listMarkdownFiles(cfg.memoryRoot)
  const key = navKey(mdFiles, cfg, maxChars, redact)
  if (navCache.key === key && typeof navCache.text === 'string') return navCache.text

  // 导航和召回共用同一套状态判定：已经不参与召回的小节，也不该出现在常驻导航里。
  // 否则一条被淘汰的旧决策会从「召回」这个口子消失，又从「导航」那个口子回去。
  const statusMap = loadStatusMap(cfg)
  const entries = collectEntries(cfg, mdFiles).filter((entry) => {
    // 统一调用 status.mjs 的权威状态解析，覆盖内容身份与行号兜底，并支持降级保守控制
    const status = resolveEntryStatus({
      contentId: entry.contentId,
      text: entry.text,
      sourceId: entry.source === 'dialogue' ? 'dialogue:' + entry.line : null,
      id: entry.source === 'dialogue' ? 'dialogue:' + entry.line : null,
    }, statusMap)
    return isRecallable(status, { degraded: statusMap.degraded, conservative: true })
  })
  if (entries.length === 0) {
    navCache.key = key
    navCache.text = ''
    return ''
  }
  // 先按天排新鲜度；同一天里整理过的档案（对话/日记/状态）排在原始捕获前面，
  // 免得十几条自动捕获把「最近记忆」整段占了。
  const dayOf = (entry) =>
    entry.date || (entry.at ? new Date(entry.at).toISOString().slice(0, 10) : '')
  const priorityOf = (source) => (source === 'dialogue' ? 0 : source === 'autocapture' ? 2 : 1)
  entries.sort((a, b) => {
    const dayA = dayOf(a)
    const dayB = dayOf(b)
    if (dayA !== dayB) return dayA < dayB ? 1 : -1
    const priority = priorityOf(a.source) - priorityOf(b.source)
    if (priority !== 0) return priority
    return (b.at || 0) - (a.at || 0)
  })

  const clean = (text) => (redact ? sanitize(text) : text)
  const topics = []
  for (const entry of entries) {
    const cleaned = clean(entry.title)
    if (!cleaned) continue
    const title = cleaned.length > 30 ? cleaned.slice(0, 29) + '…' : cleaned
    if (topics.includes(title)) continue
    if (topics.length >= MAX_NAV_ENTRIES) break
    topics.push(title)
  }

  const footer = '需要细节时按关键词回查档案，不要凭印象补。'
  const headerBase = '[记忆导航] 档案主题：'
  const maxHeader = Math.max(40, maxChars - footer.length - 8)
  let header = headerBase + topics.join('、')
  if (header.length > maxHeader) header = header.slice(0, Math.max(1, maxHeader - 1)) + '…'

  const lines = [header, '最近记忆：']
  let used = lines.join('\n').length + 1
  const room = maxChars - footer.length - 1
  const perSource = new Map()
  for (const entry of entries) {
    const count = perSource.get(entry.source) || 0
    // 单一来源最多两条，避免自动捕获把最近记忆段整段刷屏
    if (count >= 2) continue
    const day = entry.date ? entry.date.slice(5) : ''
    const keywords = (entry.keywords || []).map(clean).filter(Boolean)
    const line =
      `- ${day ? day + ' ' : ''}${sourceLabel(entry.source)}：${clean(entry.summary)}` +
      (keywords.length ? `（${keywords.join('/')}）` : '')
    if (used + line.length + 1 > room) break
    lines.push(line)
    used += line.length + 1
    perSource.set(entry.source, count + 1)
  }

  let text
  if (lines.length <= 2) {
    // 预算连一条最近记忆都放不下：只给主题，别硬塞
    text = header
  } else {
    lines.push(footer)
    text = lines.join('\n')
  }
  if (text.length > maxChars) text = text.slice(0, maxChars)

  navCache.key = key
  navCache.text = text
  return text
}

/** 对话小节 → 摘要条目（标题 + 首句 + 关键词 + 行号）。 */
export function extractDialogueSections(text) {
  return parseMarkdown(text, 'dialogue', null)
    .filter((entry) => entry.summary.length >= 8)
    .map((entry) => ({ ...entry, key: sha1(entry.title + '\n' + entry.summary).slice(0, 16) }))
}

/**
 * 后台总结：对话文件空闲且内容有新增时，把新增小节追加到 summaries.jsonl。
 *
 * @param {object} cfg dialogueFile / summaryStore / summarizeIdleMinutes / enableSanitize / summaryWatermark
 * @param {{ now?: number }} [options]
 * @returns {{ ok: boolean, reason?: string, added: number, records?: object[], watermarkFile?: string }}
 */
export function summarizeDialogue(cfg = {}, options = {}) {
  const dialogueFile = cfg.dialogueFile
  const storePath = cfg.summaryStore
  if (!dialogueFile) return { ok: false, reason: 'no_dialogue_file', added: 0 }
  if (!storePath) return { ok: false, reason: 'no_summary_store', added: 0 }

  // 和自动捕获同一条规矩：摘要存档不许落进 memory/（解开软链并对称防御）。
  const normalizedStore = realPathish(storePath).replace(/\\/g, '/')
  if (/(?:^|\/)memory(?:\/|$)/i.test(normalizedStore)) {
    return { ok: false, reason: 'forbidden_memory_store', added: 0 }
  }
  if (cfg.memoryRoot) {
    try {
      assertSafeWritePath(storePath, cfg.memoryRoot)
    } catch {
      return { ok: false, reason: 'forbidden_memory_store', added: 0 }
    }
  }

  const now = Number(options.now) || Date.now()
  const idleMinutes = clampInt(cfg.summarizeIdleMinutes, 1, 1440, 30)
  const st = statOf(dialogueFile)
  if (!st || !st.isFile()) return { ok: false, reason: 'no_dialogue_file', added: 0 }
  const idleMs = now - st.mtimeMs
  if (idleMs < idleMinutes * 60 * 1000) {
    return { ok: false, reason: 'not_idle', added: 0, idleMs, idleMinutes }
  }

  const text = readText(dialogueFile)
  if (!text.trim()) return { ok: false, reason: 'empty', added: 0 }

  const hash = sha1(text)
  const watermarkFile = cfg.summaryWatermark || storePath + '.watermark.json'
  const watermark = readJson(watermarkFile)
  if (watermark.lastHash === hash) return { ok: true, reason: 'unchanged', added: 0, watermarkFile }

  const seen = new Set(
    Array.isArray(watermark.seen) ? watermark.seen.filter((key) => typeof key === 'string') : [],
  )
  const existing = new Set(
    readCaptureStore(storePath)
      .map((record) => (record && record.id) || '')
      .filter(Boolean),
  )
  const fresh = extractDialogueSections(text).filter(
    (section) => !seen.has(section.key) && !existing.has('sum-' + section.key),
  )

  const at = new Date(now).toISOString()
  if (fresh.length === 0) {
    try {
      writeJsonAtomic(watermarkFile, {
        ...watermark,
        lastHash: hash,
        lastAt: at,
        count: Number(watermark.count) || 0,
      })
    } catch {
      /* 水位写不进去也不影响本次结论 */
    }
    return { ok: true, reason: 'no_new_sections', added: 0, watermarkFile }
  }

  const redact = cfg.enableSanitize !== false
  const records = fresh.map((section) => {
    const title = redact ? sanitize(section.title) : section.title
    const summary = redact ? sanitize(section.summary) : section.summary
    return {
      id: 'sum-' + section.key,
      type: 'dialogue_summary',
      title,
      summary,
      keywords: (section.keywords || []).map((keyword) => (redact ? sanitize(keyword) : keyword)),
      source: 'dialogue',
      // 必须和 consolidate.mjs 写进 structured.jsonl 的格式一致（dialogue:行号），
      // 否则召回时拿它去状态表里查永远查不到，被淘汰原文的摘要会重新进池。
      // 早期版本这里写的是「对话记录.md#L123」，读取端保留了兼容。
      source_id: `dialogue:${section.line}`,
      // 原文内容身份：和 consolidate.mjs 写进 structured.jsonl 的 id 同一套算法
      content_id: section.raw ? idOf(section.raw) : null,
      created_at: at,
      day: at.slice(0, 10),
    }
  })

  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.appendFileSync(storePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  } catch (error) {
    return { ok: false, reason: 'write_failed', added: 0, error: String((error && error.message) || error) }
  }

  const nextSeen = [...seen, ...fresh.map((section) => section.key)].slice(-MAX_SEEN)
  try {
    writeJsonAtomic(watermarkFile, {
      seen: nextSeen,
      lastHash: hash,
      lastAt: at,
      count: (Number(watermark.count) || 0) + fresh.length,
    })
  } catch {
    /* 水位没写成：下次靠 summaries.jsonl 里的 id 去重 */
  }

  return { ok: true, added: fresh.length, records, watermarkFile, storePath }
}
