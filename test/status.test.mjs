import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'

// 打真实 recall 与真实 consolidate，不复制任何实现。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

const body = [
  '## 2026-10-20',
  '',
  '### 技术栈选型',
  '',
  '项目当前确定使用方案 A 作为主力技术栈，理由是团队熟悉并且生态成熟，这个决定已经落地执行了一段时间。',
  '',
  '### 部署环境',
  '',
  '部署环境固定在 Linux 服务器上运行，使用 systemd 管理进程，日志走 journalctl 收集，这套配置已经稳定运行很久了。',
  '',
  '### 改主意了',
  '',
  '经过评估之后决定把技术栈换成方案 B，原来的方案 A 不再使用，方案 B 在性能和维护性上都更好一些。',
  '',
].join('\n')
fs.writeFileSync(dialogueFile, body, 'utf8')

consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const cfg = {
  dialogueFile,
  memoryRoot,
  structuredFile,
  autocaptureStore: null,
  topK: 8,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}

const readRecs = () =>
  fs
    .readFileSync(structuredFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null // 第 6 步故意写坏的行走这里
      }
    })
    .filter(Boolean)
const writeRecs = (recs) => fs.writeFileSync(structuredFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const idsOf = (q) => recall(cfg, q, Date.now() + 5000).map((h) => h.entry.id)

// ── 基线：还没标状态时，两条技术栈记录都该召回 ─────────────────────
const baseline = idsOf('技术栈方案')
assert.equal(baseline.length >= 2, true, `基线应召回新旧两条，实际 ${baseline.length}`)

let recs = readRecs()
assert.equal(recs.length, 3, '三个小节各一条')
const oldA = recs.find((r) => r.quote.includes('方案 A'))
const newB = recs.find((r) => r.quote.includes('方案 B'))
const deploy = recs.find((r) => r.quote.includes('部署环境'))
assert.ok(oldA && newB && deploy, '三条记录都能按内容找到')

// ── 1. 基本替代：A 标 superseded 后不再召回，B 仍然召回 ───────────
recs = readRecs()
recs.find((r) => r.id === oldA.id).status = 'superseded'
recs.find((r) => r.id === newB.id).supersedes = oldA.id
writeRecs(recs)

const afterSupersede = idsOf('技术栈方案')
assert.ok(!afterSupersede.includes(oldA.source_id), '被取代的旧方案不该再召回')
assert.ok(afterSupersede.includes(newB.source_id), '新方案仍然召回')

// ── 2. 无关记忆不受影响 ──────────────────────────────────────────
assert.ok(idsOf('部署环境').includes(deploy.source_id), '替代关系不该误伤别的主题')

// ── 3. 关系优先于状态字段：旧记录写着 active 但被 supersedes 指到，照样排除 ──
recs = readRecs()
recs.find((r) => r.id === oldA.id).status = 'active' // 故意写回 active，模拟改状态漏一半
writeRecs(recs)
const inconsistent = idsOf('技术栈方案')
assert.ok(!inconsistent.includes(oldA.source_id), 'supersedes 关系优先于 status 字段')
assert.ok(inconsistent.includes(newB.source_id), '新方案仍召回')

// ── 4. archived / draft 都不参与召回 ────────────────────────────
for (const st of ['archived', 'draft']) {
  recs = readRecs()
  recs.find((r) => r.id === deploy.id).status = st
  writeRecs(recs)
  assert.ok(!idsOf('部署环境').includes(deploy.source_id), `status=${st} 不该召回`)
  recs = readRecs()
  recs.find((r) => r.id === deploy.id).status = 'active'
  writeRecs(recs)
}
assert.ok(idsOf('部署环境').includes(deploy.source_id), '恢复 active 后又能召回')

// ── 5. 缺 status 的旧记录按兼容策略保留 ─────────────────────────
recs = readRecs()
delete recs.find((r) => r.id === deploy.id).status
writeRecs(recs)
assert.ok(idsOf('部署环境').includes(deploy.source_id), '缺 status 的旧记录仍参与召回')

// ── 6. 坏数据不能把召回搞崩 ─────────────────────────────────────
recs = readRecs()
recs.find((r) => r.id === newB.id).supersedes = 'mem-不存在的目标'
writeRecs(recs)
assert.ok(idsOf('技术栈方案').includes(newB.source_id), 'supersedes 指向不存在的 id 时不影响自己')

fs.appendFileSync(structuredFile, '{ 这一行是坏 JSON\n')
assert.ok(Array.isArray(idsOf('技术栈方案')), '损坏行不该让召回抛异常')

// ── 7. 多次替代 A -> B -> C：只有最新的 C 留下来 ──────────────────
fs.appendFileSync(
  dialogueFile,
  '\n### 再改一次\n\n最后又把技术栈定成了方案 C，方案 B 也不再使用，方案 C 是当前唯一在用的选择。\n',
  'utf8',
)
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })
recs = readRecs().filter((r) => r && r.id)
const recC = recs.find((r) => r.quote.includes('方案 C'))
assert.ok(recC, '追加的小节已固化')
recs = recs.filter(Boolean)
// 第 6 步把 newB.supersedes 改成了不存在的目标，这里要把整条关系链接回去
recs.find((r) => r.id === oldA.id).status = 'superseded'
recs.find((r) => r.id === newB.id).supersedes = oldA.id
recs.find((r) => r.id === newB.id).status = 'superseded'
recs.find((r) => r.id === recC.id).supersedes = newB.id
writeRecs(recs)
const chain = idsOf('技术栈方案')
assert.ok(chain.includes(recC.source_id), '最新的方案 C 召回')
assert.ok(!chain.includes(oldA.source_id), '最老的方案 A 不召回')
assert.ok(!chain.includes(newB.source_id), '中间被取代的方案 B 不召回')

// ── 8. 行号漂移：在对话记录开头插一节，所有 source_id 整体后移 ──────────
// 旧记录的行号对不上了，但内容签名还能对上，状态必须继续生效。
const inserted = [
  '## 2026-10-19',
  '',
  '### 最开头补写的一节',
  '',
  '这是后来补写在文件最前面的一段历史内容，作用是把后面所有小节的行号整体往后推。',
  '',
  '',
].join('\n')
// 注意读当前文件而不是用 body 常量：第 7 步已经往文件尾部追加过「方案 C」那一节了
const currentDialogue = fs.readFileSync(dialogueFile, 'utf8')
fs.writeFileSync(dialogueFile, inserted + currentDialogue, 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const driftHits = recall(cfg, '技术栈方案', Date.now() + 5000)
const driftText = driftHits.map((h) => h.entry.text).join('\n')
assert.ok(!driftText.includes('方案 A'), '行号漂移后被取代的记录仍然不该召回（内容签名兜底）')
assert.ok(driftText.includes('方案 C'), '当前有效的方案 C 仍然召回')

// ── 9. 长文本：超过 200 原始字符 + 大量空白，漂移后状态仍然生效 ─────────
// 这条专门盯一个曾经的错：早先用「归一化后截 200 字」当内容签名，
// 而 structured.jsonl 存的是「先截 200 字再归一化」的 quote，两边不是同一样东西，
// 长段落直接对不上，行号一漂状态就全丢。现在改用完整内容的哈希作为身份。
const longSection =
  '### 超长的一节\n\n' +
  '这一节故意写得非常长，中间夹着许多换行与空格，用来制造超过两百字符的原始文本，\n' +
  '同时还要保证它的内容和前面几节完全不同，避免和别的记忆撞在一起。\n'.repeat(6)
fs.appendFileSync(dialogueFile, '\n' + longSection + '\n', 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const recsLong = readRecs()
const longRec = recsLong.find((r) => r.quote.includes('超长的一节'))
assert.ok(longRec, '长小节已固化')
assert.ok(longRec.quote.length === 200, 'quote 仍是 200 字截断')
assert.ok(longRec.quote !== longSection.trim(), 'quote 确实是截断过的，不是全文')

// 先把长小节标成 superseded，再由另一条记录指过来
const longMarker = recsLong.find((r) => r.id !== longRec.id && r.status === 'active')
assert.ok(longMarker, '需要一条 active 记录来做替代者')
recsLong.find((r) => r.id === longRec.id).status = 'superseded'
writeRecs(recsLong)
assert.ok(
  !recall(cfg, '超长的一节', Date.now() + 5000).map((h) => h.entry.text).join('\n').includes('超长的一节'),
  '长文本被标记后不该召回',
)

// 再插一段开头内容让行号整体漂移，状态必须靠完整内容 ID 继续生效
const drift2 = '## 2026-10-18\n\n### 又一次补写\n\n再把一段内容插到最前面，让所有小节的行号整体往后挪一次。\n\n'
fs.writeFileSync(dialogueFile, drift2 + fs.readFileSync(dialogueFile, 'utf8'), 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const afterLongDrift = recall(cfg, '超长的一节', Date.now() + 5000)
const longHits = afterLongDrift.map((h) => h.entry.text).join('\n')
assert.ok(!longHits.includes('超长的一节'), '长文本 + 行号漂移后，被取代的记录仍然不该召回')

fs.rmSync(dir, { recursive: true, force: true })
console.log('status tests passed')
