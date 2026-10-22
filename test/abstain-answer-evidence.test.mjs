import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, REASON, VERDICT } from '../abstain.mjs'
import { recallWithVerdict } from '../index.js'
import { consolidate } from '../consolidate.mjs'

/**
 * 答案证据判据的回归测试。
 *
 * 分两层：
 *   1. 手写 hit 数组，验证「命中词够了、但没回答问题」必须拒答，以及正例不能误杀；
 *   2. 留出集 test/fixtures/holdout-abstain.json 走真实 recall + decide，
 *      统计错误接受 / 错误拒绝。留出集与冻结集语料完全无关，不参与调阈值。
 */

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function hit(text, score = 13, coverage = 0.4, matched = 4, extra = {}) {
  return {
    entry: { id: 'h-' + Math.random().toString(36).slice(2, 8), text },
    score,
    rawScore: score,
    preDecayScore: score,
    coverage,
    matched,
    queryMatched: matched,
    expansionMatched: 0,
    ...extra,
  }
}

const BRAND_Q = '备份用的移动硬盘是什么牌子的'
const BRAND_TEXT = '### 备份策略\n\n重要的文档每周日自动备份到移动硬盘，代码全部推到 GitHub，本地的照片单独做一份冷备份。'
const GIL_Q = 'Python 的 GIL 怎么绕过'
const GIL_TEXT = '### 代码风格又改了\n\n代码风格改成四个空格了，因为新项目用的是 Python，想跟它保持一致，prettier 的配置也同步更新。'

// ---------- 红队两条：词面过线但没回答问题 ----------

test('只提到移动硬盘、没提牌子 -> attribute-unanswered', () => {
  const r = decide([hit(BRAND_TEXT)], BRAND_Q)
  assert.equal(r.verdict, VERDICT.ABSTAIN, '提到了移动硬盘不等于说了牌子')
  assert.equal(r.reason, REASON.ATTRIBUTE_UNANSWERED)
  assert.equal(r.evidenceStrength, 0)
})

test('只提到 Python、没提 GIL -> term-unanswered', () => {
  const r = decide([hit(GIL_TEXT)], GIL_Q)
  assert.equal(r.verdict, VERDICT.ABSTAIN, '提到了 Python 不等于回答了 GIL 怎么绕过')
  assert.equal(r.reason, REASON.TERM_UNANSWERED)
  assert.equal(r.evidenceStrength, 0)
})

// ---------- 正例不许被误杀 ----------

test('牌子真的在命中里 -> 仍然 answer', () => {
  const r = decide([hit('移动硬盘买的是希捷的 4TB 那款，接在台式机上放照片和视频素材。')], BRAND_Q)
  assert.equal(r.verdict, VERDICT.ANSWER)
})

test('GIL 真的在命中里 -> 仍然 answer', () => {
  const r = decide([hit('Python 的 GIL 可以用多进程绕开，multiprocessing 每个进程有独立解释器。')], GIL_Q)
  assert.equal(r.verdict, VERDICT.ANSWER)
})

test('数量问句，命中里有数词 -> answer', () => {
  const r = decide([hit('笔记文件每六小时同步一次网盘，冲突保留两边副本，不自动覆盖。')], '笔记多久同步一次')
  assert.equal(r.verdict, VERDICT.ANSWER)
})

test('数量问句，命中里只有「会同步」没有频次 -> abstain', () => {
  const r = decide([hit('笔记文件会同步到网盘，具体工具还没挑好，先这样用着，不折腾自建方案。')], '笔记多久同步一次')
  assert.equal(r.verdict, VERDICT.ABSTAIN)
  assert.equal(r.reason, REASON.ATTRIBUTE_UNANSWERED)
})

test('属性词出现但状态是「还没定」-> abstain', () => {
  const r = decide([hit('日志路径还没定，等运维确认后再写进配置，现在先输出到标准输出。')], '日志路径是什么')
  assert.equal(r.verdict, VERDICT.ABSTAIN)
  assert.equal(r.reason, REASON.ATTRIBUTE_UNANSWERED)
})

test('正文拿不到时放行，不因为缺字段把所有候选拒掉', () => {
  const bare = { score: 13, coverage: 0.4, matched: 4, queryMatched: 4, preDecayScore: 13, expansionMatched: 0 }
  assert.equal(decide([bare], BRAND_Q).verdict, VERDICT.ANSWER)
})

// ---------- top1 答不上来、候选里有答案：降级成 ambiguous 而不是拒答 ----------

test('top1 不回答但另一条候选回答 -> ambiguous / evidence-elsewhere', () => {
  const wrong = hit('### 代码风格又改了\n\n代码风格改成四个空格了，因为新项目用的是 Python，prettier 配置同步更新。', 10, 0.3, 3)
  const right = hit('数据库统一使用 PostgreSQL 15，迁移脚本放在 migrations 目录下面统一管理。', 9, 0.3, 3)
  const r = decide([wrong, right], '迁移脚本放在哪个目录下管理')
  assert.equal(r.verdict, VERDICT.AMBIGUOUS, '候选里有答案，只是排第一的那条没答上，不该说「没有」')
  assert.equal(r.reason, REASON.EVIDENCE_ELSEWHERE)
  assert.ok(r.evidenceStrength > 0 && r.evidenceStrength < 1)
})

// ---------- 开关与兼容 ----------

test('answerEvidence:false 退回旧判定（证明差异来自这条判据）', () => {
  assert.equal(decide([hit(BRAND_TEXT)], BRAND_Q).verdict, VERDICT.ABSTAIN)
  assert.equal(decide([hit(BRAND_TEXT)], BRAND_Q, { answerEvidence: false }).verdict, VERDICT.ANSWER)
  assert.equal(decide([hit(GIL_TEXT)], GIL_Q, { answerEvidence: false }).verdict, VERDICT.ANSWER)
})

test('返回结构不变：只有 verdict / evidenceStrength / reason，没有 confidence', () => {
  const samples = [
    decide([], BRAND_Q),
    decide([hit(BRAND_TEXT)], BRAND_Q),
    decide([hit('移动硬盘买的是希捷的 4TB 那款。')], BRAND_Q),
    decide([hit('a', 10, 0.5, 4), hit('b', 9.6, 0.5, 4)], BRAND_Q),
  ]
  for (const r of samples) {
    assert.deepEqual(Object.keys(r).sort(), ['evidenceStrength', 'reason', 'verdict'])
    assert.ok(Object.values(VERDICT).includes(r.verdict))
    assert.equal(typeof r.evidenceStrength, 'number')
    assert.ok(!('confidence' in r))
  }
})

test('纯函数：不修改传入的 hits', () => {
  const hits = [hit(BRAND_TEXT), hit('移动硬盘买的是希捷的 4TB 那款。', 9)]
  const before = JSON.stringify(hits)
  decide(hits, BRAND_Q)
  assert.equal(JSON.stringify(hits), before)
})

test('新增理由码都在 REASON 里，调用方可以按字符串分支', () => {
  for (const key of ['ATTRIBUTE_UNANSWERED', 'TERM_UNANSWERED', 'EVIDENCE_ELSEWHERE']) {
    assert.equal(typeof REASON[key], 'string')
    assert.ok(REASON[key].length > 0)
  }
})

// ---------- 留出集：真实 recall + decide，端到端 ----------

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(here, 'fixtures', 'holdout-abstain.json')

test('留出集：范围内错误接受 0、错误拒绝 0（范围外样本单独列出）', () => {
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  assert.ok(fx.cases.length >= 20, '留出集至少 20 条，实际 ' + fx.cases.length)
  assert.ok(fx.cases.some((c) => c.expect == null), '留出集必须有反例')
  assert.ok(fx.cases.some((c) => c.expect != null), '留出集必须有正例')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-abstain-'))
  const memoryRoot = path.join(dir, 'memory')
  const sd = path.join(memoryRoot, '记忆')
  fs.mkdirSync(sd, { recursive: true })
  const dialogueFile = path.join(dir, '对话记录.md')
  const structuredFile = path.join(sd, 'structured.jsonl')
  const watermarkFile = path.join(sd, '.watermark.json')
  const md = ['## 2026-10-22', '']
  for (const entry of fx.corpus) md.push('### ' + entry.fact, '', entry.text, '')
  fs.writeFileSync(dialogueFile, md.join('\n'), 'utf8')
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

  // scope 标记的是「词面判据本来就覆盖不到」的样本：同一段里区分两个实体（N2）、
  // 查询里根本没有属性词（N10）。它们照样跑、照样打印，但不计入判据的通过条件，
  // 免得把「判据做不到的事」记到「判据做错了」头上。
  const falseAccepts = []
  const falseRejects = []
  const outOfScope = []
  for (const c of fx.cases) {
    const r = recallWithVerdict(cfg, c.q, Date.now() + 5000)
    const row = c.id + ' ' + c.q + ' -> ' + r.verdict + ' (' + r.reason + ')'
    if (c.expect == null) {
      if (r.verdict !== VERDICT.ABSTAIN) {
        if (c.scope) outOfScope.push(row)
        else falseAccepts.push(row)
      }
    } else if (r.verdict === VERDICT.ABSTAIN) {
      falseRejects.push(row)
    }
  }
  console.log(
    '  留出集 ' + fx.cases.length + ' 条：错误接受 ' + falseAccepts.length +
      '，错误拒绝 ' + falseRejects.length + '，范围外观察 ' + outOfScope.length,
  )
  for (const x of falseAccepts) console.log('    [误收] ' + x)
  for (const x of falseRejects) console.log('    [误拒] ' + x)
  for (const x of outOfScope) console.log('    [范围外] ' + x)
  assert.deepEqual(falseRejects, [], '有答案的留出查询不许被拒答')
  assert.deepEqual(falseAccepts, [], '无答案留出查询不许被判成有答案')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- runner ----------

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('ok   ' + t.name)
  } catch (e) {
    failed += 1
    console.error('FAIL ' + t.name)
    console.error('     ' + (e && e.message))
  }
}
console.log('')
console.log((tests.length - failed) + '/' + tests.length + ' passed')
if (failed > 0) process.exitCode = 1
