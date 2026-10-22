import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consolidate, resolveCliPaths } from '../consolidate.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-'))
const dialogueFile = path.join(dir, '对话记录.md')
const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')

const body = [
  '## 第一段：选型',
  '',
  '这次决定用文件存储而不是数据库，因为档案规模还很小，先冻结评测再谈升级，避免过早引入复杂度。',
  '',
  '## 第二段：排障',
  '',
  '报错原因是 KV cache 被切成了四份，改成单槽之后六万五千上下文就能正常装下了，问题解决。',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')

// 1) 首次固化：两条小节都该写进去
const r1 = consolidate({ dialogueFile, outputFile, watermarkFile })
assert.equal(r1.written, 2, 'first run writes both sections')
assert.equal(r1.total, 2)
assert.ok(fs.existsSync(outputFile), 'output file created')
assert.ok(fs.existsSync(watermarkFile), 'watermark created next to output, not in a dev folder')

// 2) 幂等：同样内容再跑一次不该重复写
const r2 = consolidate({ dialogueFile, outputFile, watermarkFile })
assert.equal(r2.written, 0, 'second run is idempotent')
assert.equal(r2.total, 2, 'no duplicates appended')

// 3) 新增小节：只写增量
fs.appendFileSync(dialogueFile, '\n## 第三段：收尾\n\n把临时文件清理干净，日志挪回家目录下面的专属目录里，避免散落在工作区根目录。\n', 'utf8')
const r3 = consolidate({ dialogueFile, outputFile, watermarkFile })
assert.equal(r3.written, 1, 'only the new section is written')
assert.equal(r3.total, 3)

// 4) 引文必须能在原文里找到（source 变了就不写）
const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
for (const rec of lines) {
  assert.ok(body.includes(rec.quote) || rec.quote.startsWith('## 第三段'), `quote must be verbatim: ${rec.id}`)
  assert.ok(rec.source_id.startsWith('dialogue:'), 'source_id recorded')
  assert.equal(rec.status, 'active')
}

// 5) 缺参数 / 文件不存在必须报错，不能静默当成空对话
assert.throws(() => consolidate({ dialogueFile, outputFile }), /缺少 watermarkFile/)
assert.throws(() => consolidate({ dialogueFile: path.join(dir, 'nope.md'), outputFile, watermarkFile }), /不存在/)

// 6) CLI 路径解析：环境变量优先
const resolved = resolveCliPaths(
  {
    DSH_MEMORY_DIALOGUE: dialogueFile,
    DSH_MEMORY_ROOT: path.join(dir, 'custom'),
    DSH_MEMORY_STRUCTURED: path.join(dir, 'custom', 'out.jsonl'),
    DSH_MEMORY_WATERMARK: path.join(dir, 'custom', '.wm.json'),
  },
  dir,
)
assert.equal(resolved.dialogueFile, dialogueFile)
assert.equal(resolved.outputFile, path.join(dir, 'custom', 'out.jsonl'))
assert.equal(resolved.watermarkFile, path.join(dir, 'custom', '.wm.json'))

// 7) 找不到对话文件时要抛错（而不是返回空路径继续跑）
assert.throws(() => resolveCliPaths({}, os.tmpdir()), /找不到对话记录/)

fs.rmSync(dir, { recursive: true, force: true })
console.log('consolidate tests passed')
