import assert from 'node:assert'
import { buildBlock } from '../index.js'

// 长条目必须被截断并标注原文字数，短条目不被动。
const hits = [
  { entry: { id: 'dialogue:1', src: 'dialogue', line: 1, text: '长'.repeat(3000) }, score: 1 },
  { entry: { id: 'dialogue:2', src: 'dialogue', line: 2, text: '这条很短，不该被截。' }, score: 0.5 },
]
const block = buildBlock(hits, 'answer', 800)
assert.ok(block.includes('…（后略，原文 3000 字）'), '长条目应标注截断')
assert.ok(block.includes('这条很短，不该被截。'), '短条目应完整保留')
const tooLong = block.split('\n').filter((l) => l.length > 900)
assert.equal(tooLong.length, 0, '注入块里不应出现超过上限太多的一行')

// 默认上限 800：不传参也不能把 3000 字原样灌进去。
const dflt = buildBlock(hits, 'answer')
assert.ok(dflt.includes('…（后略，原文 3000 字）'), '默认上限应生效')

// 上限为 0 或非法时按「不截断」处理，不能把内容砍没。
const noCap = buildBlock([{ entry: { id: 'x', src: 's', text: '短' }, score: 1 }], 'answer', 0)
assert.ok(noCap.includes('短'), '非法上限时内容仍在')

console.log('recall-truncate: PASSED')