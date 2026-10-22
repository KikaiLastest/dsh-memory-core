import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertSafeWritePath, atomicWriteFile, atomicWriteJson } from '../fs-safe.mjs'
import { autoCapture } from '../autocapture.mjs'
import { summarizeDialogue } from '../summary.mjs'
import { normalizeConfig, validatePatch } from '../config.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-security-'))
const memoryRoot = path.join(dir, 'memory')
fs.mkdirSync(memoryRoot, { recursive: true })

// ── 1. 路径安全与穿越防护测试 ───────────────────────────────────────────
// 尝试通过相对路径 .. 或直接子目录写穿进 memory/ 目录
assert.throws(() => {
  assertSafeWritePath(path.join(memoryRoot, 'malicious.jsonl'), memoryRoot)
}, /禁止写入受保护目录/)

assert.throws(() => {
  const traversal = path.join(dir, 'other', '..', 'memory', 'hacked.jsonl')
  assertSafeWritePath(traversal, memoryRoot)
}, /禁止写入受保护目录/)

// 自动捕获与摘要两模块对受保护目录的拦截对称性
assert.throws(() => {
  autoCapture({
    text: '记住新的密钥 sk-1234567890abcdef',
    storePath: path.join(memoryRoot, 'captures.jsonl'),
    memoryRoot,
  })
}, /forbidden to write into memory directory/)

const sumRes = summarizeDialogue({
  dialogueFile: path.join(dir, 'dialogue.md'),
  summaryStore: path.join(memoryRoot, 'summaries.jsonl'),
  memoryRoot,
})
assert.equal(sumRes.ok, false)
assert.equal(sumRes.reason, 'forbidden_memory_store')

// ── 2. 并发原子写入安全性测试（无 .tmp 命名竞争）────────────────────────
const targetFile = path.join(dir, 'atomic-target.json')
const promises = []
for (let i = 0; i < 20; i++) {
  promises.push(
    new Promise((resolve) => {
      atomicWriteJson(targetFile, { round: i, timestamp: Date.now() })
      resolve(true)
    })
  )
}
await Promise.all(promises)
const finalContent = JSON.parse(fs.readFileSync(targetFile, 'utf8'))
assert.ok(typeof finalContent.round === 'number', '并发原子写入必须生成合法完好的 JSON，无踩踏破损')

// 检查目录中绝无遗留的 .tmp 文件
const files = fs.readdirSync(dir)
const leftoverTmps = files.filter((f) => f.includes('.tmp'))
assert.deepEqual(leftoverTmps, [], '原子写入完成后绝不遗留任何 .tmp 临时文件')

// ── 3. 配置归一化与校验类型一致性测试 ──────────────────────────────────
// 字符串 "false" 绝不可被粗暴的 Boolean("false") 误转为 true
const cfgStringFalse = normalizeConfig({ enableAutoCapture: 'false', enableStable: '0' })
assert.strictEqual(cfgStringFalse.enableAutoCapture, false, '"false" 字符串必须被规范化为布尔值 false')
assert.strictEqual(cfgStringFalse.enableStable, false, '"0" 字符串必须被规范化为布尔值 false')

const cfgStringTrue = normalizeConfig({ enableAutoCapture: 'true', enableStable: '1' })
assert.strictEqual(cfgStringTrue.enableAutoCapture, true, '"true" 字符串必须被规范化为布尔值 true')
assert.strictEqual(cfgStringTrue.enableStable, true, '"1" 字符串必须被规范化为布尔值 true')

const patchOk = validatePatch({ enableAutoCapture: false, topK: 3 })
assert.strictEqual(patchOk.ok, true)
assert.strictEqual(patchOk.values.enableAutoCapture, false)

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('fs atomic security and config tests passed')
