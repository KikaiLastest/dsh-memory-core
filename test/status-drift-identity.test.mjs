// ── 生命周期回归：内容身份与物理位置必须彻底分离 ────────────────────────
// 红队复现：只改小节标题（正文一字未动）并在文件上方插入两行，
// 已被 superseded 的旧结论重新被 recall 返回。
// 根因：resolveEntryStatus 第三层拿 sourceId 坐标直接查状态表。标题一改，
// 内容哈希失配；坐标再被上方插入行推动，要么撞上另一条记录、要么落空，
// 两条路都会把一条旧事实放回召回池。
//
// 修法：内容身份优先；内容失配时用「正文前缀 / 标题」做弱身份；
// 弱身份也没有、只有坐标撞上记录 → 判为漂移，不再信任位置。
//
// 本文件锁四件事：
//   1. 改标题 + 行号漂移 → 不召回（修复前为红）
//   2. 坐标撞上别的记录（status=active）→ 不召回（修复前为红）
//   3. 状态表完全没覆盖的来源文件 → 照常召回（防过度保守）
//   4. 只治理过个别小节的文件，其余小节不得连坐（合成基准 40:1 的回归）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { recall, invalidateMemoryCache } from '../index.js'
import { consolidate, sections } from '../consolidate.mjs'
import { loadStatusMap, filterRecallableEntries } from '../status.mjs'

const tmpDirs = []
const mkTmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-drift-' + tag + '-'))
  tmpDirs.push(d)
  return d
}
const cfgOf = (memoryRoot, dialogueFile, structuredFile) => ({
  memoryRoot,
  dialogueFile,
  structuredFile,
  autocaptureStore: null,
  summaryStore: null,
  topK: 8,
  minCoverage: 0.2,
  minMatched: 2,
  minRatio: 0.3,
  halfLifeDays: 30,
})

try {
  // ── 1. 改标题 + 行号漂移：被 superseded 的小节不得复活 ───────────────
  {
    const dir = mkTmp('rename')
    const memoryRoot = path.join(dir, 'memory')
    const structuredDir = path.join(memoryRoot, '记忆')
    const dialogueFile = path.join(dir, '对话记录.md')
    const structuredFile = path.join(structuredDir, 'structured.jsonl')
    const watermarkFile = path.join(structuredDir, '.watermark.json')
    fs.mkdirSync(structuredDir, { recursive: true })

    const body = [
      '## 2026-10-18',
      '',
      '### 数据库选型',
      '',
      '数据库统一使用 PostgreSQL 15 作为主库，连接串走环境变量注入，不写死在代码里，迁移脚本放 migrations 目录。',
      '',
      '### 部署位置',
      '',
      '服务部署在测试机 10.0.0.5 上，先跑一周看看稳定性，没有问题再切到正式环境去，配置一起迁。',
      '',
      '### 代码风格',
      '',
      '项目统一用两个空格缩进，提交前跑一遍 prettier，行宽限制在一百个字符以内，不做例外。',
      '',
    ].join('\n')
    fs.writeFileSync(dialogueFile, body, 'utf8')
    consolidate({ dialogueFile, outputFile: structuredFile, watermarkFile })

    const recs = fs
      .readFileSync(structuredFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const oldRec = recs.find((r) => r.quote.includes('PostgreSQL 15'))
    assert.ok(oldRec, '旧结论先正常固化，才有「被淘汰」可言')
    oldRec.status = 'superseded'
    fs.writeFileSync(structuredFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    const oldSection = sections(body).find((s) => s.text.includes('PostgreSQL 15'))
    assert.ok(oldSection, '原始小节可切分')

    // 正文一字未动，只改标题；顶部插两行把后面小节整体推下去。
    const renamed = body.replace('### 数据库选型', '### 数据库选型（旧记录，已废弃）')
    const prefix = '补记第一行，只是把下面的行号整体往下推。\n补记第二行，内容和旧结论完全无关。\n\n'
    fs.writeFileSync(dialogueFile, prefix + renamed, 'utf8')

    const drifted = sections(fs.readFileSync(dialogueFile, 'utf8')).find((s) => s.text.includes('PostgreSQL 15'))
    assert.ok(drifted.line > oldSection.line, '物理行号确实漂了')

    const map = loadStatusMap({ structuredFile })
    assert.equal(map.degraded, false, '纯漂移不是状态表损坏')
    assert.equal(
      map.bySourceId.has('dialogue:' + drifted.line),
      false,
      '漂移后的新坐标在状态表里没有任何记录（坐标落空，只能靠来源文件治理信号）',
    )

    const entry = {
      id: 'dialogue:' + drifted.line,
      src: 'dialogue',
      line: drifted.line,
      sourceId: 'dialogue:' + drifted.line,
      text: drifted.text,
    }
    const filtered = filterRecallableEntries([entry], map)
    assert.equal(
      filtered.recallable.length,
      0,
      '改标题 + 行号漂移后，已被 superseded 的小节不得进入召回池（修复前它会直接放行）',
    )

    invalidateMemoryCache()
    const hits = recall(cfgOf(memoryRoot, dialogueFile, structuredFile), '数据库 PostgreSQL 15 主库', Date.now() + 5000)
    assert.ok(
      !hits.some((h) => h.entry.text.includes('PostgreSQL 15')),
      'recall 端不得复活被淘汰的旧结论',
    )

    // 同一文件里没被改过的小节照常召回：修复不能一刀切掉整个文件。
    invalidateMemoryCache()
    const deployHits = recall(cfgOf(memoryRoot, dialogueFile, structuredFile), '部署位置 测试机 10.0.0.5', Date.now() + 5000)
    assert.ok(
      deployHits.some((h) => h.entry.text.includes('10.0.0.5')),
      '未被淘汰、内容未变的小节必须照常召回',
    )
  }

  // ── 2. 坐标撞上另一条 active 记录：位置不是身份，不得借它放行 ────────
  {
    const dir = mkTmp('collide')
    const cfile = path.join(dir, 'structured.jsonl')
    const tOld = '### 数据库选型（旧记录，已废弃）\n\n数据库统一使用 PostgreSQL 15 作为主库，连接串走环境变量注入，不写死在代码里，迁移脚本放 migrations 目录。'
    const tActive = '### 部署位置\n\n服务部署在测试机 10.0.0.5 上，先跑一周看看稳定性，没有问题再切到正式环境去，配置一起迁。'
    const recs = [
      { id: 'mem-old', source_id: 'dialogue:3', status: 'superseded', quote: tOld.slice(0, 200) },
      { id: 'mem-active', source_id: 'dialogue:7', status: 'active', quote: tActive.slice(0, 200) },
    ]
    fs.writeFileSync(cfile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const map = loadStatusMap({ structuredFile: cfile })
    assert.equal(map.degraded, false)

    // 正文和标题都跟状态表里任何一条对不上，只有物理坐标撞上了 dialogue:7。
    const unrelated =
      '### 另一条完全无关的旧记录\n\n这条正文的开头和状态表里任何一条记录都不一样，只是物理坐标刚好撞上了第七行，不能因此继承 active。'
    const entry = { id: 'dialogue:7', src: 'dialogue', line: 7, sourceId: 'dialogue:7', text: unrelated }
    const filtered = filterRecallableEntries([entry], map)
    assert.equal(
      filtered.recallable.length,
      0,
      '坐标撞上一条 active 记录、内容身份却对不上时，必须按漂移拦截，不能把位置当成身份',
    )
    assert.equal(filtered.idDrift, 1, '纯坐标碰撞要记账，方便观测')
  }

  // ── 3. 状态表完全没覆盖的来源文件：保持向后兼容，照常召回 ─────────────
  {
    const dir = mkTmp('ungoverned')
    const memoryRoot = path.join(dir, 'memory')
    const structuredDir = path.join(memoryRoot, '记忆')
    fs.mkdirSync(structuredDir, { recursive: true })
    const dialogueFile = path.join(dir, '对话记录.md')
    const structuredFile = path.join(structuredDir, 'structured.jsonl')
    const diaryFile = path.join(memoryRoot, '日记.md')
    fs.writeFileSync(dialogueFile, '', 'utf8')

    const diaryText =
      '### 一直保留的偏好\n\n我不吃香菜，点外卖的时候记得备注不要香菜，这条偏好很久以前就定下来了，一直没有变过。'
    fs.writeFileSync(diaryFile, diaryText + '\n', 'utf8')
    // 状态表只治理对话文件（dialogue: 前缀），日记文件一条记录都没有。
    fs.writeFileSync(
      structuredFile,
      JSON.stringify({ id: 'mem-some-other', source_id: 'dialogue:1', status: 'superseded' }) + '\n',
      'utf8',
    )

    const map = loadStatusMap({ structuredFile })
    assert.equal(map.degraded, false)
    const diaryEntry = { id: 'diary:1', src: 'diary', line: 1, sourceId: 'diary:1', text: diaryText }
    const kept = filterRecallableEntries([diaryEntry], map)
    assert.equal(kept.recallable.length, 1, '状态表没覆盖的文件不得被整体打死（防过度保守）')

    invalidateMemoryCache()
    const hits = recall(cfgOf(memoryRoot, dialogueFile, structuredFile), '外卖 香菜 备注', Date.now() + 5000)
    assert.ok(
      hits.some((h) => h.entry.text.includes('不吃香菜')),
      '完全未治理的日记文件必须照常可召回',
    )

    // 对照：同一份文件里只固化过个别小节时，其余没被治理、也没有任何
    // 文本/坐标证据的小节必须照常放行。否则「合成基准 40 条 + 状态表 1 条」
    // 会把整份语料连坐打死——这是第一版文件级治理踩过的坑。
    const stranger = {
      id: 'dialogue:5',
      src: 'dialogue',
      line: 5,
      sourceId: 'dialogue:5',
      text: '### 没被固化过的对话小节\n\n这段内容从来没有进过状态表，正文和坐标也跟任何一条记录不重合，应当照常可召回。',
    }
    const keptStranger = filterRecallableEntries([stranger], map)
    assert.equal(keptStranger.recallable.length, 1, '只治理过个别小节的文件不得整体连坐')
  }

  // ── 4. 状态表不存在（首次运行）：全部放行 ────────────────────────────
  {
    const dir = mkTmp('nostate')
    const map = loadStatusMap({ structuredFile: path.join(dir, 'missing.jsonl') })
    assert.equal(map.reason, 'missing')
    const entry = { id: 'dialogue:1', src: 'dialogue', line: 1, sourceId: 'dialogue:1', text: '随便一段对话小节正文，长度足够，用来验证首次运行时的向后兼容策略。' }
    const kept = filterRecallableEntries([entry], map)
    assert.equal(kept.recallable.length, 1, '状态表不存在时不得拦任何记忆')
  }

  console.log('status drift identity tests passed')
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
}
