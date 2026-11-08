import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { capQuotes, pruneStaleLocks, rotateBackups, runStorageGc } from '../gc.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-gc-'))
const mem = path.join(dir, '记忆')
fs.mkdirSync(path.join(dir, '生长'), { recursive: true })
fs.mkdirSync(mem, { recursive: true })

// 1. 轮转：同一前缀留最新一份
for (const s of ['20261020', '20261021', '20261022']) {
  fs.writeFileSync(path.join(mem, 'structured.jsonl.bak-' + s), '{}')
}
const removed = rotateBackups(mem, 1)
assert.equal(removed.length, 2, '删掉两个旧备份')
const left = fs.readdirSync(mem).filter((n) => n.includes('.bak-'))
assert.deepEqual(left, ['structured.jsonl.bak-20261022'], '只留最新一份')

// 2. 僵尸锁：0 字节且过期才清
const stale = path.join(dir, '.dsh-ops-update-abc.lock')
fs.writeFileSync(stale, '')
const old = Date.now() - 3 * 60 * 60 * 1000
fs.utimesSync(stale, new Date(old), new Date(old))
const fresh = path.join(dir, '生长', '.dsh-ops-update-def.lock')
fs.writeFileSync(fresh, '')
assert.equal(pruneStaleLocks(dir, 60), 1, '只清过期那把')
assert.ok(fs.existsSync(fresh), '新鲜锁不动')

// 3. quote 截断
const structured = path.join(mem, 'structured.jsonl')
const long = 'x'.repeat(1200)
fs.writeFileSync(structured, JSON.stringify({ id: 'm1', quote: long }) + '\n' + JSON.stringify({ id: 'm2', quote: 'short' }) + '\n')
const q = capQuotes(structured, 600)
assert.equal(q.changed, 1, '只改超长那条')
const rows = fs.readFileSync(structured, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
assert.ok(rows[0].quote.length < 700, '截断生效')
assert.match(rows[0].quote, /原文 1200 字/)
assert.equal(rows[1].quote, 'short', '短的不动')
assert.ok(q.after < q.before, '文件确实变小')

// 4. 一次跑完
fs.writeFileSync(path.join(mem, 'structured.jsonl.bak-20200101'), '{}')
const stats = runStorageGc({ memoryRoot: dir })
assert.ok(Array.isArray(stats.backupsRemoved))
assert.equal(stats.locksRemoved, 0, '没有新的过期锁')

fs.rmSync(dir, { recursive: true, force: true })
console.log('gc tests passed')
