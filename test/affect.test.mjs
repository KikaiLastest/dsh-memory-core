import assert from 'node:assert'
import { classify, applyEvent, decay, toneHint, defaultState } from '../affect.mjs'

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

console.log('affect tests passed')
