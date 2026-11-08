/**
 * 存储 GC —— 档案目录里的三样垃圾：轮转备份、零字节僵尸锁、过长的 quote。
 *
 * 为什么单独成模块：它只动文件、不碰召回逻辑，出问题最多是「少清了一次」，
 * 不该把插件启动拖下水。所以这里全部 best-effort，永不抛异常。
 *
 * 三件事：
 *  1. rotateBackups：同名的 *.bak-* 只留最新 keep 份，其余删掉；
 *  2. pruneStaleLocks：0 字节的 .dsh-ops-update-*.lock 超过 staleMinutes 就清；
 *  3. capQuotes：structured.jsonl 里过长的 quote 截断并标注原文字数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function readJsonl(file) {
  const out = []
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行原样跳过，不因一条坏数据丢掉整个文件 */
    }
  }
  return out
}

/** 同目录下按文件名前缀轮转备份，只留最新 keep 份。返回删掉的文件名。 */
export function rotateBackups(dir, keep = 1) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const groups = new Map()
  for (const n of names) {
    const m = n.match(/^(.*)\.bak-(.+)$/)
    if (!m) continue
    const base = m[1]
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push(n)
  }
  const removed = []
  for (const list of groups.values()) {
    if (list.length <= keep) continue
    // 文件名后缀是日期时间，按字符串倒序即最新在前；数量多时也不依赖 mtime
    const sorted = [...list].sort().reverse()
    for (const n of sorted.slice(keep)) {
      try {
        fs.unlinkSync(path.join(dir, n))
        removed.push(n)
      } catch {
        /* 删不掉就留着，下次再说 */
      }
    }
  }
  return removed
}

/** 清掉零字节、且超过 staleMinutes 的 .dsh-ops-update-*.lock。返回清掉的个数。 */
export function pruneStaleLocks(root, staleMinutes = 60, now = Date.now()) {
  let count = 0
  const walk = (dir, depth) => {
    if (depth > 4) return
    let items = []
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!/^\.dsh-ops-update-.*\.lock$/.test(it.name)) continue
      try {
        const st = fs.statSync(full)
        if (st.size === 0 && now - st.mtimeMs > staleMinutes * 60 * 1000) {
          fs.unlinkSync(full)
          count++
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  walk(root, 0)
  return count
}

/** 截断过长的 quote，返回 {before, after, changed} 字节数统计。 */
export function capQuotes(file, maxChars = 600) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { changed: 0, before: 0, after: 0 }
  }
  const before = Buffer.byteLength(raw)
  const rows = []
  let changed = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      rows.push(line)
      continue
    }
    if (typeof obj.quote === 'string' && obj.quote.length > maxChars) {
      const original = obj.quote.length
      obj.quote = obj.quote.slice(0, maxChars) + `…（后略，原文 ${original} 字）`
      changed++
    }
    rows.push(JSON.stringify(obj))
  }
  const out = rows.join('\n') + '\n'
  if (changed > 0) {
    try {
      fs.writeFileSync(file + '.tmp-gc', out)
      fs.renameSync(file + '.tmp-gc', file)
    } catch {
      try {
        fs.writeFileSync(file, out)
      } catch {
        /* 放弃 */
      }
    }
  }
  return { changed, before, after: Buffer.byteLength(out) }
}

/** 命令行入口：node gc.mjs [记忆根目录]。不带参数时按 DSH 默认工作区猜。 */
export function main(argv = process.argv) {
  const root =
    argv[2] ||
    process.env.DSH_MEMORY_ROOT ||
    path.join(process.env.USERPROFILE || os.homedir(), 'dsh-workspace', 'memory')
  const stats = runStorageGc({ memoryRoot: root })
  console.log('memoryRoot:', root)
  console.log('backups removed:', stats.backupsRemoved.length ? stats.backupsRemoved.join(', ') : '(none)')
  console.log('stale locks removed:', stats.locksRemoved)
  console.log('quotes truncated:', stats.quotesChanged, '| bytes', stats.before, '->', stats.after)
  return stats
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\//, ''))) {
  main()
}

/** 一次把三件事都做了，返回可打印的统计。 */
export function runStorageGc({ memoryRoot, keepBackups = 1, maxQuoteChars = 600, staleMinutes = 60 } = {}) {
  const stats = { backupsRemoved: [], locksRemoved: 0, quotesChanged: 0, before: 0, after: 0 }
  if (!memoryRoot) return stats
  const mem = path.join(memoryRoot, '记忆')
  const structured = path.join(mem, 'structured.jsonl')
  try {
    stats.backupsRemoved = rotateBackups(path.dirname(structured), keepBackups)
  } catch {
    /* ignore */
  }
  try {
    stats.locksRemoved = pruneStaleLocks(memoryRoot, staleMinutes)
  } catch {
    /* ignore */
  }
  try {
    const q = capQuotes(structured, maxQuoteChars)
    stats.quotesChanged = q.changed
    stats.before = q.before
    stats.after = q.after
  } catch {
    /* ignore */
  }
  return stats
}
