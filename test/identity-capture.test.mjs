import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  autoCapture,
  readCaptureStore,
  canonicalBody,
  bodyId,
  captureContentId,
  linkCaptureToSource,
  toCaptureEntry,
} from '../autocapture.mjs'
import { consolidate } from '../consolidate.mjs'
import { summarizeDialogue, clearSummaryCache } from '../summary.mjs'
import { idOf, loadStatusMap, resolveEntryStatus, isRecallable, filterRecallableEntries } from '../status.mjs'

// 回归目标：同一段正文的三个副本（原文 / 摘要 / 自动捕获）必须解析出同一个状态。
// 旧实现里捕获记录只有 {id,type,text,weight,created_at,source}，status.mjs 的三层身份
// （contentId / 正文哈希 / sourceId）全部落空，健康状态表把 null 当可召回，
// 于是正文标 superseded 后，捕获副本照样进候选池。
//
// 这里不 import index.js，直接复用 index.js 读取侧同构的投影：
//   toCaptureEntry(record, entries) 就是给集成者准备的读取侧接入点。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-capture-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')
const summaryStore = path.join(dir, 'summaries.jsonl')
const captureStore = path.join(dir, 'captures.jsonl')

const oldTitle = '### 旧缓存方案'
const oldBody = '这一版临时采用了旧的缓存方案，后来因为一致性太差被整体换掉，不要再按它来。'
const newTitle = '### 新缓存方案'
const newBody = '现在稳定跑着的是新的缓存方案，读写都走它，维护节奏也已经按它安排好了。'
const oldSection = oldTitle + '\n\n' + oldBody
const newSection = newTitle + '\n\n' + newBody

fs.writeFileSync(
  dialogueFile,
  ['## 2026-10-22', '', oldSection, '', newSection, ''].join('\n'),
  'utf8',
)

// 1) 真实固化：structured.jsonl 的 id 是「整节原文（含标题）」哈希
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const recs = readJsonl(structuredFile)
const oldRec = recs.find((rec) => rec.fact === '旧缓存方案')
const newRec = recs.find((rec) => rec.fact === '新缓存方案')
assert.ok(oldRec && newRec, '固化应产生新旧两条记录')

// 2) 真实摘要：summary.mjs 写的 content_id 必须和固化 id 对齐
const oldMtime = new Date(Date.now() - 60 * 60 * 1000)
fs.utimesSync(dialogueFile, oldMtime, oldMtime)
clearSummaryCache()
const gen = summarizeDialogue(
  { dialogueFile, summaryStore, summarizeIdleMinutes: 30, enableSanitize: true },
  { now: Date.now() },
)
assert.equal(gen.ok, true, '摘要生成成功')
const summaries = readJsonl(summaryStore)
const oldSummary = summaries.find((summary) => summary.title === '旧缓存方案')
assert.ok(oldSummary, '找得到旧方案的摘要')
assert.equal(oldSummary.content_id, oldRec.id, '摘要 content_id 必须与固化 id 同源')

// 3) 把旧方案标成 superseded，构造真实状态表
const patched = recs.map((rec) => (rec.fact === '旧缓存方案' ? { ...rec, status: 'superseded' } : rec))
fs.writeFileSync(structuredFile, patched.map((rec) => JSON.stringify(rec)).join('\n') + '\n', 'utf8')
const statusMap = loadStatusMap({ structuredFile })
assert.equal(statusMap.reason, 'ok', '状态表健康')

const oldEntry = {
  id: oldRec.source_id,
  src: 'dialogue',
  line: Number(oldRec.source_id.split(':')[1]),
  text: oldSection,
  weight: 1.0,
}
const newEntry = {
  id: newRec.source_id,
  src: 'dialogue',
  line: Number(newRec.source_id.split(':')[1]),
  text: newSection,
  weight: 1.0,
}
const newSummary = summaries.find((summary) => summary.title === '新缓存方案')
assert.ok(newSummary, '找得到新方案的摘要')

// 4) 规范化正文：标题行不参与身份，标题改动不影响正文哈希
assert.equal(canonicalBody('### 标题\r\n\r\n正文  \r\n'), '正文', '正文规范化为去标题、去首尾空白')
assert.equal(bodyId('### 旧标题\n\n' + oldBody), bodyId('### 新标题\n\n' + oldBody), '标题变化不改变正文身份')

// 5) 捕获落盘必须自带正文身份
const cap = autoCapture({
  text: oldBody,
  storePath: captureStore,
  dailyQuota: 10,
  now: Date.parse('2026-10-22T12:00:00.000Z'),
})
assert.equal(cap.captured, true, '旧方案正文可被捕获')
const record = cap.record
assert.match(record.bodyId || '', /^mem-[0-9a-f]{12}$/, '落盘 bodyId 必须是规范化正文哈希')
assert.equal(record.bodyId, bodyId(oldBody), 'bodyId 必须等于规范化正文哈希')
assert.equal(record.contentId, bodyId(oldBody), '没有显式 contentId 时回落到正文身份')
assert.equal(record.sourceId, null, '不知道来源坐标时写 null，不猜')
assert.equal(captureContentId(record), idOf(oldBody), 'captureContentId 必须等于同一段正文的 idOf')
assert.equal(linkCaptureToSource(record, [oldEntry, newEntry]).contentId, oldRec.id, '读取侧应把捕获副本接回原文小节')

// 6) 旧行为（集成前 index.js 的投影）确实会泄漏：身份全落空 -> null -> 可召回
const beforeIntegration = {
  id: record.id,
  src: record.source,
  line: 0,
  text: record.text,
  weight: record.weight,
}
assert.equal(resolveEntryStatus(beforeIntegration, statusMap), null, '不接身份时状态解析落空')
assert.equal(isRecallable(null), true, '健康表把 null 当可召回（缺陷前提）')
assert.equal(filterRecallableEntries([beforeIntegration], statusMap).recallable.length, 1, '缺陷复现：捕获副本仍在候选池')

// 7) 集成后的读取侧投影：同一段正文的原文 / 摘要 / 捕获三个副本状态一致
const linked = toCaptureEntry(record, [oldEntry, newEntry])
assert.equal(linked.contentId, oldRec.id, '捕获副本回填整节 contentId')
assert.equal(linked.sourceId, oldRec.source_id, '捕获副本回填来源坐标')
assert.equal(resolveEntryStatus(oldEntry, statusMap), 'superseded', '原文副本已淘汰')
assert.equal(
  resolveEntryStatus(
    {
      id: oldSummary.id,
      src: 'summary',
      text: oldSummary.title + '\n' + oldSummary.summary,
      contentId: oldSummary.content_id,
      sourceId: oldSummary.source_id,
    },
    statusMap,
  ),
  'superseded',
  '摘要副本已淘汰',
)
assert.equal(resolveEntryStatus(linked, statusMap), 'superseded', '捕获副本也必须解析为已淘汰')
assert.deepEqual(
  filterRecallableEntries([linked], statusMap).recallable,
  [],
  'superseded 正文的捕获副本不得再进候选池',
)
assert.equal(filterRecallableEntries([linked], statusMap).suppressed, 1, '过滤计数应记录 1 条淘汰')

// 8) 不能一刀切误伤新内容：新方案的捕获副本仍应可召回
const capNew = autoCapture({
  text: newBody,
  storePath: captureStore,
  dailyQuota: 10,
  now: Date.parse('2026-10-22T12:01:00.000Z'),
})
assert.equal(capNew.captured, true)
const linkedNew = toCaptureEntry(capNew.record, [oldEntry, newEntry])
assert.equal(linkedNew.contentId, newRec.id, '新捕获副本接到新小节')
assert.equal(resolveEntryStatus(linkedNew, statusMap), 'active', '新内容仍是 active')
assert.equal(filterRecallableEntries([linkedNew], statusMap).recallable.length, 1, '新内容不被误伤')

// 8b) 已经投影进池的捕获条目不能被当成原文小节：autoCapture 默认 source='dialogue'，
// 只按 src 匹配会把上一条 line=0 的捕获当成原文，必须靠 line>0 排除。
const fakeCaptured = {
  id: 'cap-prev',
  src: 'dialogue',
  line: 0,
  text: oldBody,
  contentId: 'mem-000000000000',
}
const linkedToFake = toCaptureEntry(record, [fakeCaptured])
assert.equal(linkedToFake.contentId, idOf(oldBody), '不能把上一条捕获当成原文小节')
assert.equal(linkedToFake.sourceId, null, '没有真实原文坐标时保持 null')

// 9) 向后兼容：没有 contentId/bodyId 的旧捕获记录，靠正文哈希仍能接回来源
const legacy = { id: 'cap-legacy', type: 'auto_capture', text: oldBody, source: 'dialogue' }
assert.equal(captureContentId(legacy), idOf(oldBody), '旧记录回落到正文哈希')
assert.equal(resolveEntryStatus(toCaptureEntry(legacy, [oldEntry, newEntry]), statusMap), 'superseded', '旧记录也能被拦截')

// 10) 落盘 JSON 里确实带上了这些字段
const stored = readCaptureStore(captureStore)
assert.equal(stored.length, 2, '两条捕获记录')
const storedOld = stored.find((item) => item.text === oldBody)
assert.equal(storedOld.contentId, idOf(oldBody), 'JSONL 中的 contentId 可追溯')
assert.equal(storedOld.bodyId, idOf(oldBody), 'JSONL 中的 bodyId 可追溯')

fs.rmSync(dir, { recursive: true, force: true })
console.log('identity-capture tests passed')
