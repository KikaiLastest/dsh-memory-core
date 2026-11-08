import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeToolEvent, recordActivity, sessionTag, targetPath, WRITE_TOOLS } from '../activity.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-activity-'))
const file = path.join(dir, 'activity.jsonl')
const now = Date.now()

// 1. 写类工具被记录，读类工具被忽略
const w = recordActivity({ file, session: 'sess-A', tool: 'write', args: { file_path: 'D:/x/a.md', content: 'SECRET-CONTENT' }, now })
assert.ok(w && w.path, 'write 记到了路径')
assert.equal(recordActivity({ file, session: 'sess-A', tool: 'read', args: { file_path: 'D:/x/a.md' }, now }), null, 'read 不记')

// 2. 内容不落盘
const raw = fs.readFileSync(file, 'utf8')
assert.ok(!raw.includes('SECRET-CONTENT'), '文件内容没有落盘')
assert.ok(!raw.includes('sess-A'), 'session 只留哈希')

// 3. 同一路径、不同会话 → 撞车
const c = recordActivity({ file, session: 'sess-B', tool: 'edit', args: { file_path: 'D:/x/a.md', new_string: 'zzz' }, now: now + 1000 })
assert.ok(c && c.collisions.length === 1, '另一会话改同一文件算撞车')
assert.notEqual(c.collisions[0].session, sessionTag('sess-B'))

// 4. 同一会话重复改 → 不算撞车
recordActivity({ file, session: 'sess-B', tool: 'edit', args: { file_path: 'D:/x/own.md' }, now: now + 2000 })
const c2 = recordActivity({ file, session: 'sess-B', tool: 'edit', args: { file_path: 'D:/x/own.md' }, now: now + 3000 })
assert.ok(c2 && c2.collisions.length === 0, '只有自己改过就不算撞车')

// 5. 窗口外不算
const c3 = recordActivity({ file, session: 'sess-C', tool: 'write', args: { file_path: 'D:/x/a.md' }, now: now + 60 * 60 * 1000 })
assert.ok(c3 && c3.collisions.length === 0, '一小时前的不算同时')

// 6. payload 形状归一
const ev = normalizeToolEvent({ tool: { name: 'write' }, args: { file_path: 'D:/y/b.md' }, sessionId: 's1' })
assert.equal(ev.tool, 'write')
assert.equal(ev.session, 's1')
assert.equal(normalizeToolEvent({}), null)
assert.equal(normalizeToolEvent(null), null)
assert.ok(WRITE_TOOLS.has('edit'))
assert.equal(targetPath({ path: '/tmp/x' }), '/tmp/x')
assert.equal(targetPath({}), '')

fs.rmSync(dir, { recursive: true, force: true })
console.log('activity tests passed')
