import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall, recallDiagnostics } from '../index.js'
import { consolidate } from '../consolidate.mjs'

/**
 * 候选发现层的反例测试。
 *
 * 修掉的 bug：recall() 先用原始查询的 2-gram 建 pool，扩展重试时**还在扫同一个 pool**。
 * 于是「原始 2-gram 只命中弱相关条目、正确记忆只含扩展词」时，
 * 正确记忆根本没进过评分，扩展权重算得再对也没用。
 *
 * 这里的语料是专门为这个反例搭的：
 *   查询「换成什么了」的原始 2-gram 只命中「配色改动」那条（弱匹配，matched = 1），
 *   正确记忆「方案调整」一个原始 2-gram 都不含，只有扩展词（改用 / 推翻 / 改成）。
 * 修之前：正确记忆进不了 pool，返回空；修之后：能进候选并排到第一。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expansion-candidates-'))
const memoryRoot = path.join(dir, 'memory')
const structuredDir = path.join(memoryRoot, '记忆')
fs.mkdirSync(structuredDir, { recursive: true })
const dialogueFile = path.join(dir, '对话记录.md')
const structuredFile = path.join(structuredDir, 'structured.jsonl')
const watermarkFile = path.join(structuredDir, '.watermark.json')

const CORPUS = [
  '## 2026-10-22',
  '',
  '### 配色改动',
  '',
  '把界面配色换成深色模式，夜里看代码的时候眼睛舒服很多，旧的那套主题先留着没有删掉。',
  '',
  '### 方案调整',
  '',
  '后来改用别的思路，把之前那个定时轮询的做法推翻，改成事件驱动加失败重试。',
  '',
  '### 部署脚本',
  '',
  '部署脚本里写死了上线目标地址，重复执行会覆盖线上配置，所以执行前必须人工确认。',
  '',
]
fs.writeFileSync(dialogueFile, CORPUS.join('\n'), 'utf8')
consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

const cfg = {
  memoryRoot,
  dialogueFile,
  structuredFile,
  topK: 3,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
}
const now = () => Date.now() + 5000

// 小节的序号 == 它在对话记录里的起始行号（1 起），splitEntries 的 id 就是这么拼的。
// 用行号而不是正文去定位，是为了让断言指向「哪一条记忆」，而不是「哪段文字得分高」。
const idOfSection = (title) => {
  const idx = CORPUS.findIndex((l) => l.startsWith('### ') && l.includes(title))
  assert.ok(idx >= 0, '语料里找不到小节：' + title)
  return 'dialogue:' + (idx + 1)
}
const WEAK_ID = idOfSection('配色改动')
const CORRECT_ID = idOfSection('方案调整')

// ---------- 反例 1：弱原始匹配 + 正确记忆只匹配扩展词 ----------
const q = '换成什么了'
const { hits, trace } = recallDiagnostics(cfg, q, now())

assert.ok(trace.queryGrams >= 4, '查询要够长（>=4 个 2-gram）才会走扩展回退')
assert.deepStrictEqual(trace.expansionWords.sort(), ['改主意', '改成', '改用', '推翻'].sort(), '扩展词应来自 synonym 组')
assert.ok(trace.expansionWeight >= 0.8, 'synonym 组权重应为 0.8')

// bug 的直接观察点：原始候选里只有弱相关的那一条，正确记忆不在里面。
assert.ok(trace.originalCandidates.includes(WEAK_ID), '弱相关条目应该由原始 2-gram 带进来')
assert.ok(!trace.originalCandidates.includes(CORRECT_ID), '反例前提：正确记忆不含任何原始 2-gram，进不了原始候选池')

// 修复后的行为：两路候选做并集，正确记忆必须进候选池。
assert.ok(trace.retryCandidates.includes(CORRECT_ID), '修复后正确记忆必须能进扩展候选池')

// 而且要真能得分：纯扩展命中不能被 queryScore = 0 的上限压成 0 分。
assert.strictEqual(hits.length, 1, '应召回一条')
const hit = hits[0]
assert.strictEqual(hit.entry.id, CORRECT_ID, '正确记忆应排第一，而不是弱原始匹配那条')
assert.strictEqual(hit.queryMatched, 0, '正确记忆的原始命中数应为 0')
assert.ok(hit.expansionMatched >= 2, '纯扩展放行要求至少两个扩展片段命中')
assert.strictEqual(hit.coverage, 0, '原始命中为 0 时覆盖率就是 0，这是定义不是 bug')
assert.ok(hit.score > 0, '候选进了池还得有分，否则等于没修')
// 恒等式在纯扩展路径上同样成立
assert.ok(Math.abs(hit.preDecayScore - (hit.queryScore + hit.effectiveExpansionScore)) < 1e-9, '分数分解对不上')
assert.ok(hit.effectiveExpansionScore <= hit.expansionScore + 1e-9, '截断后的扩展分不该大于截断前')
assert.ok(!hit.entry.text.includes('配色'), '弱相关条目不该被顶到第一')

// ---------- 反例 2：扩大候选池不能把「相关词」误召放进来 ----------
// 「服务跑在什么环境上」只命中 related 组（权重 0.4）。部署脚本那条能中两个扩展词，
// 但它和查询没有原始交集，只能进候选池，不能出现在结果里。
const control = '服务跑在什么环境上'
const c = recallDiagnostics(cfg, control, now())
assert.ok(c.trace.originalCandidates.length === 0, '这条查询没有原始候选，正好验证纯扩展通道')
assert.ok(c.trace.expansionWeight < 0.8, 'related 组权重应低于 synonym 组')
assert.ok(c.trace.retryCandidates.length > 0, '扩展候选应该进池（受控并集不是空转）')
// 受控：池子只收 gramIndex 真命中的条目，不退回全语料兜底。
const countSections = CORPUS.filter((l) => l.startsWith('### ')).length
assert.ok(c.trace.retryScanned < countSections, '扩展池只收索引命中的条目，不该退回全语料扫描')
assert.strictEqual(c.hits.length, 0, 'related 组的纯扩展候选必须被闸挡住（无答案不许误召）')

// ---------- 回归：诊断入口不能改变 recall 的行为 ----------
assert.deepStrictEqual(
  recall(cfg, q, now()).map((h) => h.entry.id),
  hits.map((h) => h.entry.id),
  'recallDiagnostics 必须和 recall 返回一致的命中',
)

fs.rmSync(dir, { recursive: true, force: true })
console.log(
  'expansion candidate tests passed (' +
    'correct=' + hit.entry.id +
    ', original=' + trace.originalCandidates.join('/') +
    ', retry=' + trace.retryCandidates.join('/') +
    ')',
)
