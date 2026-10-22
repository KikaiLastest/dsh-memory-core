// 导航通道的行号漂移回归：被取代的小节不能借着行号变化从导航复活。
//
// 背景：parseMarkdown 产出的小节原文在 raw 上（含标题行），正文在 body 上。
// 状态表记录的 id 是「正文内容哈希」。如果 buildNav 拿 raw 去算哈希，
// 永远对不上状态表，一旦上方插入内容导致行号漂移，就会被判成「无状态」而重新出现。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { buildNav, clearSummaryCache } from '../summary.mjs'
import { idOf } from '../status.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-drift-'))
const mem = path.join(root, '记忆')
fs.mkdirSync(mem, { recursive: true })
const md = path.join(mem, '日记.md')
const structured = path.join(mem, 'structured.jsonl')

const body = '我们决定使用 MySQL 5.7 作为主库，不做分片。'
const oldSection = '## 旧方案\n\n' + body
const tail = '## 其他章节\n\n一些无关内容。\n'

const cfg = {
  memoryRoot: root,
  structuredFile: structured,
  enableReplace: false,
  enableSanitize: false,
}

try {
  // 1) 未被淘汰时，导航里应当看得到
  fs.writeFileSync(md, oldSection + '\n\n' + tail, 'utf8')
  clearSummaryCache()
  const navBefore = buildNav(cfg, { maxChars: 2000 })
  assert.ok(navBefore.includes('MySQL'), '未被淘汰的小节应出现在导航里')

  // 2) 标记为 superseded（状态表用正文哈希作 id）
  fs.writeFileSync(
    structured,
    JSON.stringify({ id: idOf(body), source_id: 'mem:日记.md:1', text: body, status: 'superseded' }) + '\n',
    'utf8',
  )
  clearSummaryCache()
  const navAfter = buildNav(cfg, { maxChars: 2000 })
  assert.ok(!navAfter.includes('MySQL 5.7'), '已被取代的小节不应出现在导航里')

  // 3) 行号漂移：上方插入新章节，旧小节整体下移
  fs.writeFileSync(md, '## 新增前置章节\n\n漂移填充。\n\n' + oldSection + '\n\n' + tail, 'utf8')
  clearSummaryCache()
  const navDrift = buildNav(cfg, { maxChars: 2000 })
  assert.ok(
    !navDrift.includes('MySQL 5.7'),
    '行号漂移后，已被取代的小节不能从导航通道复活',
  )

  console.log('nav line-drift tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
