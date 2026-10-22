import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classify,
  applyEvent,
  decay,
  toneHint,
  defaultState,
  loadState,
  saveState,
  getLastError,
} from '../affect.mjs'

assert.equal(classify('谢谢你').kind, 'praise')
assert.equal(classify('你个废物').kind, 'scold')
assert.equal(classify('摸摸鱼鱼').kind, 'affection')
assert.equal(classify('帮我看看报错').kind, 'serious')
assert.equal(classify('哈哈哈哈').kind, 'casual')
assert.equal(classify('嗯'), null)

let s = defaultState()
for (let i = 0; i < 20; i += 1) {
  s = applyEvent(s, { kind: 'praise', valence: 0.15, arousal: 0.05, eventId: 'e' + i })
}
assert.ok(s.valence <= 1, 'valence clamped')
assert.ok(s.arousal <= 1, 'arousal clamped')

const before = s.valence
s = applyEvent(s, { kind: 'praise', valence: 0.15, eventId: 'e19' })
assert.equal(s.valence, before, 'duplicate event ignored')

const oldState = {
  ...defaultState(),
  valence: 1,
  arousal: 1,
  updated_at: new Date(Date.now() - 10 * 3600000).toISOString(),
}
const d = decay(oldState)
assert.ok(d.valence < 1, 'valence decays')
assert.ok(d.valence > 0, 'valence does not jump to baseline')

assert.match(toneHint({ valence: -0.5, arousal: 0.3 }), /蔫/)
assert.match(toneHint({ valence: 0.5, arousal: 0.8 }), /活泼/)
assert.equal(toneHint({ valence: 0, arousal: 0.3 }), '')

// ── 边界：合法的 0 不能被当成「缺省」 ─────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-'))
const stateFile = path.join(dir, 'state.json')

fs.writeFileSync(stateFile, JSON.stringify({ valence: 1, arousal: 0, applied: [] }), 'utf8')
const zero = loadState(stateFile)
assert.equal(zero.arousal, 0, 'arousal=0 must survive load, not fall back to baseline')
assert.equal(zero.valence, 1, 'valence=1 preserved')

// 负数 / 越界 / NaN 仍然要夹紧或回退
fs.writeFileSync(stateFile, JSON.stringify({ valence: -0.5, arousal: 9, applied: [] }), 'utf8')
const clamped = loadState(stateFile)
assert.equal(clamped.valence, -0.5)
assert.equal(clamped.arousal, 1, 'out-of-range arousal clamped to 1')

fs.writeFileSync(stateFile, JSON.stringify({ valence: 'oops', arousal: null, applied: [] }), 'utf8')
const bogus = loadState(stateFile)
assert.equal(bogus.valence, 0, 'non-numeric valence falls back')
assert.equal(bogus.arousal, 0.3, 'null arousal falls back to baseline')

// 损坏文件：降级为默认值，但要留下错误痕迹
fs.writeFileSync(stateFile, '{ not json', 'utf8')
const broken = loadState(stateFile)
assert.equal(broken.arousal, 0.3, 'corrupt file degrades to default')
assert.ok(getLastError() && getLastError().op === 'load', 'corrupt load is recorded, not silent')

// ── 并发写：临时文件名必须唯一 ─────────────────────────────────────────
assert.equal(saveState(stateFile, { ...defaultState(), valence: 0.4 }), true)
assert.equal(saveState(stateFile, { ...defaultState(), valence: 0.6 }), true)
const afterConcurrent = loadState(stateFile)
assert.equal(afterConcurrent.valence, 0.6, 'last write wins, file still valid JSON')
assert.equal(getLastError(), null, 'successful save clears error')
const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
assert.equal(leftovers.length, 0, 'no temp files left behind')

// ── 无稳定 eventId 时，同类事件不能合并 ───────────────────────────────
let s2 = defaultState()
const t0 = 1_700_000_000_000
s2 = applyEvent(s2, { kind: 'praise', valence: 0.1 }, t0)
s2 = applyEvent(s2, { kind: 'praise', valence: 0.1 }, t0)
assert.ok(Math.abs(s2.valence - 0.2) < 1e-9, 'two same-kind events in the same millisecond both apply')
assert.equal(s2.applied.length, 2, 'distinct ids recorded')

// 显式 eventId 仍然是可靠的去重键
let s3 = defaultState()
s3 = applyEvent(s3, { kind: 'praise', valence: 0.1, eventId: 'x1' }, t0)
s3 = applyEvent(s3, { kind: 'praise', valence: 0.1, eventId: 'x1' }, t0 + 99999)
assert.ok(Math.abs(s3.valence - 0.1) < 1e-9, 'same eventId replayed is ignored')

fs.rmSync(dir, { recursive: true, force: true })

console.log('affect tests passed')
