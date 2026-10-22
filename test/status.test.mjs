import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall, invalidateMemoryCache } from '../index.js'
import { buildNav, clearSummaryCache } from '../summary.mjs'
import { consolidate, sections } from '../consolidate.mjs'
import {
  idOf,
  loadStatusMap,
  isRecallable,
  resolveEntryStatus,
  filterRecallableEntries,
  LEGACY_UNVERIFIED,
} from '../status.mjs'

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

// ── 10. 状态表缺失 / 损坏 / 正常，必须是三种可区分的结果 ────────────
// 兼容策略「没标过状态就放行」只对 missing 成立。文件明明在却读不出来，
// 或者整张表一行都解析不出来，等于「不知道这条记忆有没有被淘汰」——
// 这时候再全放行，被标成 superseded 的旧决策会整体回到上下文里。
{
  const missing = loadStatusMap({ structuredFile: path.join(dir, '根本没有这个文件.jsonl') })
  assert.equal(missing.degraded, false, '文件不存在是正常状态，不算降级')
  assert.equal(missing.reason, 'missing')

  const corruptFile = path.join(dir, 'corrupt.jsonl')
  fs.writeFileSync(corruptFile, '{这不是 json\n也,不是\n', 'utf8')
  const corrupt = loadStatusMap({ structuredFile: corruptFile })
  assert.equal(corrupt.degraded, true, '整表解析不出来必须报告降级')
  assert.equal(corrupt.reason, 'corrupt')
  assert.equal(corrupt.byContentId.size, 0)

  const healthy = loadStatusMap({ structuredFile })
  assert.equal(healthy.degraded, false, '正常状态表不该被判成降级')
  assert.equal(healthy.reason, 'ok')
  assert.ok(healthy.byContentId.size > 0)

  // ── 11. 部分损坏：有效记录中夹杂坏行或残缺 schema ────────────────
  // 审查阻塞点 P0：不能因为有有效记录就把整张表假装成完全健康！
  const partialCorruptFile = path.join(dir, 'partial-corrupt.jsonl')
  fs.writeFileSync(
    partialCorruptFile,
    [
      JSON.stringify({ id: 'mem-1', source_id: 'dialogue:1', status: 'active' }),
      '{坏掉的截断行，json 解析必定抛错',
      JSON.stringify({ id: 'mem-2', status: 'active' }), // 缺少关键契约 source_id
      JSON.stringify({ id: 'mem-3', source_id: 'dialogue:3', status: 'superseded' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const partial = loadStatusMap({ structuredFile: partialCorruptFile })
  assert.equal(partial.degraded, true, '部分损坏的文件必须被标记为降级状态')
  assert.equal(partial.reason, 'partial_corrupt')
  assert.equal(partial.validRecords, 2, '2 条有效合法记录应被成功解析')
  assert.equal(partial.syntaxErrors, 1, '准确统计 1 行 JSON 语法损坏')
  assert.equal(partial.schemaErrors, 1, '准确统计 1 行缺少 source_id 的 schema 损坏')
  assert.equal(partial.brokenLines, 2, '总坏行数必须准确等于 2')
  assert.equal(partial.byContentId.get('mem-3'), 'superseded', '已解析出的淘汰关系仍然可用')

  // ── 12. 零字节空文件与纯空白换行文件必须显式识别为 empty 并触发降级保护 ─────────
  // 审查阻塞点 P0：不能把存在但为空的文件误判为首次运行的 missing！
  const zeroByteFile = path.join(dir, 'zero-byte.jsonl')
  fs.writeFileSync(zeroByteFile, '', 'utf8')
  const emptyRes = loadStatusMap({ structuredFile: zeroByteFile })
  assert.equal(emptyRes.degraded, true, '零字节文件必须被标记为降级状态')
  assert.equal(emptyRes.reason, 'empty', '原因必须准确标为 empty')

  const whitespaceFile = path.join(dir, 'whitespace.jsonl')
  fs.writeFileSync(whitespaceFile, '   \n  \n\t  \n', 'utf8')
  const wsRes = loadStatusMap({ structuredFile: whitespaceFile })
  assert.equal(wsRes.degraded, true, '纯空白截断文件必须被标记为降级状态')
  assert.equal(wsRes.reason, 'empty', '原因必须准确标为 empty')

  // ── 13. 非法 status 枚举值必须被识别为 schema 错误并触发降级 ───────────────────
  const badEnumFile = path.join(dir, 'bad-enum.jsonl')
  fs.writeFileSync(
    badEnumFile,
    JSON.stringify({ id: 'mem-bad', source_id: 'dialogue:99', status: 'invalid_status_enum' }) + '\n',
    'utf8',
  )
  const badEnumRes = loadStatusMap({ structuredFile: badEnumFile })
  assert.equal(badEnumRes.degraded, true, '包含非法 status 枚举必须标记降级')
  assert.equal(badEnumRes.schemaErrors, 1, '准确统计 1 个 schema 错误')
  assert.equal(badEnumRes.validRecords, 0)

  // ── 14. 有向环路替代（Cycle Conflict：A -> B -> A）必须被精确捕获并降级 ──────
  // 审查阻塞点 P0：不能容忍循环替代逻辑悖论
  const cycleFile = path.join(dir, 'cycle.jsonl')
  fs.writeFileSync(
    cycleFile,
    [
      JSON.stringify({ id: 'mem-node-a', source_id: 'dialogue:1', status: 'active', supersedes: 'mem-node-b' }),
      JSON.stringify({ id: 'mem-node-b', source_id: 'dialogue:2', status: 'active', supersedes: 'mem-node-a' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const cycleRes = loadStatusMap({ structuredFile: cycleFile })
  assert.equal(cycleRes.degraded, true, '存在有向环路必须标记降级')
  assert.equal(cycleRes.reason, 'cycle_conflict', '原因必须准确标为 cycle_conflict')
  assert.equal(cycleRes.cycleErrors, 1, '准确统计 1 个环路错误')

  // ── 15. 悬空引用（Dangling Reference）必须触发降级保护 ───────────────────────
  const danglingFile = path.join(dir, 'dangling.jsonl')
  fs.writeFileSync(
    danglingFile,
    JSON.stringify({ id: 'mem-node-x', source_id: 'dialogue:1', status: 'active', supersedes: 'mem-non-existent' }) + '\n',
    'utf8',
  )
  const danglingRes = loadStatusMap({ structuredFile: danglingFile })
  assert.equal(danglingRes.degraded, true, '存在悬空替代引用必须标记降级')
  assert.equal(danglingRes.reason, 'dangling_reference')
  assert.equal(danglingRes.danglingRefs, 1, '准确统计 1 个悬空引用')

  // ── 16. 非法 supersedes 假值逐项严格校验（"", 0, false, [] 等）──────────────
  // 审查阻塞点 P0：不能让空值形式的非法 supersedes 绕过校验
  const illegalFalsyValues = ['', 0, false, [], {}]
  for (const badVal of illegalFalsyValues) {
    const badFalsyFile = path.join(dir, `bad-falsy-${typeof badVal}.jsonl`)
    fs.writeFileSync(
      badFalsyFile,
      JSON.stringify({ id: 'mem-falsy', source_id: 'dialogue:1', status: 'active', supersedes: badVal }) + '\n',
      'utf8',
    )
    const falsyRes = loadStatusMap({ structuredFile: badFalsyFile })
    assert.equal(falsyRes.degraded, true, `supersedes 传入 ${JSON.stringify(badVal)} 必须被判定为降级`)
    assert.equal(falsyRes.schemaErrors, 1, `supersedes 传入 ${JSON.stringify(badVal)} 必须准确计入 schema 错误`)
  }

  // ── 17. 1000 节点超长替代链迭代遍历（Stack-Safe 爆栈防御测试）─────────────
  const longChainFile = path.join(dir, 'long-chain.jsonl')
  const chainLines = []
  for (let i = 0; i < 1000; i++) {
    const item = {
      id: `mem-chain-${i}`,
      source_id: `dialogue:${i + 1}`,
      status: 'active',
      supersedes: i < 999 ? `mem-chain-${i + 1}` : null,
    }
    chainLines.push(JSON.stringify(item))
  }
  fs.writeFileSync(longChainFile, chainLines.join('\n') + '\n', 'utf8')
  const chainRes = loadStatusMap({ structuredFile: longChainFile })
  assert.equal(chainRes.degraded, false, '1000 级合法长链绝不发生递归爆栈且判定健康')
  assert.equal(chainRes.reason, 'ok')
  assert.equal(chainRes.cycleErrors, 0)
  assert.equal(chainRes.validRecords, 1000)
  // 验证替代传递生效：链条尾部已被第一节点一路替代覆盖
  assert.equal(chainRes.byContentId.get('mem-chain-999'), 'superseded')

  // ── 18. 多环与分叉环路（Multi-cycle & Forked Cycles）────────────────────────
  const multiCycleFile = path.join(dir, 'multi-cycle.jsonl')
  fs.writeFileSync(
    multiCycleFile,
    [
      // 环 1: A -> B -> A
      JSON.stringify({ id: 'mem-c1-a', source_id: 'dialogue:1', status: 'active', supersedes: 'mem-c1-b' }),
      JSON.stringify({ id: 'mem-c1-b', source_id: 'dialogue:2', status: 'active', supersedes: 'mem-c1-a' }),
      // 环 2: C -> D -> E -> C
      JSON.stringify({ id: 'mem-c2-c', source_id: 'dialogue:3', status: 'active', supersedes: 'mem-c2-d' }),
      JSON.stringify({ id: 'mem-c2-d', source_id: 'dialogue:4', status: 'active', supersedes: 'mem-c2-e' }),
      JSON.stringify({ id: 'mem-c2-e', source_id: 'dialogue:5', status: 'active', supersedes: 'mem-c2-c' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const multiCycleRes = loadStatusMap({ structuredFile: multiCycleFile })
  assert.equal(multiCycleRes.degraded, true)
  assert.equal(multiCycleRes.reason, 'cycle_conflict')
  assert.ok(multiCycleRes.cycleErrors >= 2, `多环场景必须捕获到全部环路，实际: ${multiCycleRes.cycleErrors}`)

  // ── 19. 状态映射顺序无关性测试（Order Independence Verification）───────────
  // 相同逻辑数据，顺写与逆写生成的映射必须 100% 相同
  const recordsForward = [
    { id: 'mem-order-1', source_id: 'dialogue:10', status: 'active' },
    { id: 'mem-order-2', source_id: 'dialogue:10', status: 'superseded' }, // 相同物理坐标状态漂移
    { id: 'mem-order-3', source_id: 'dialogue:20', status: 'active', supersedes: 'mem-order-1' },
  ]
  const fileFwd = path.join(dir, 'order-fwd.jsonl')
  const fileRev = path.join(dir, 'order-rev.jsonl')
  fs.writeFileSync(fileFwd, recordsForward.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  fs.writeFileSync(fileRev, [...recordsForward].reverse().map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const resFwd = loadStatusMap({ structuredFile: fileFwd })
  const resRev = loadStatusMap({ structuredFile: fileRev })
  assert.deepEqual(Object.fromEntries(resFwd.byContentId), Object.fromEntries(resRev.byContentId), '内容身份映射必须顺序无关')
  assert.deepEqual(Object.fromEntries(resFwd.bySourceId), Object.fromEntries(resRev.bySourceId), '来源坐标映射必须顺序无关')
}

// ── 12. 降级默认必须保守 ────────────────────────────────────────
// 状态表损坏时，「不知道这条有没有被淘汰」不能当成「它还有效」。
// 这个默认值曾经写成 false，而 JSDoc 写的是 true —— 安全防护被自己的默认值架空。
{
  // 正常情况：向后兼容，没标过状态的旧记录照常召回
  assert.equal(isRecallable(undefined), true)
  assert.equal(isRecallable(null), true)
  assert.equal(isRecallable('active'), true)
  assert.equal(isRecallable('superseded'), false)
  assert.equal(isRecallable('archived'), false)
  assert.equal(isRecallable('draft'), false)

  // 降级：调用方什么都不传，也必须保守
  assert.equal(isRecallable(undefined, { degraded: true }), false, '降级默认必须保守')
  assert.equal(isRecallable(undefined, { degraded: true, conservative: true }), false)

  // 显式选择宽松才放行
  assert.equal(isRecallable(undefined, { degraded: true, conservative: false }), true)

  // 显式状态永远优先于降级开关
  assert.equal(
    isRecallable('superseded', { degraded: true, conservative: false }),
    false,
    '显式废弃的记录，任何降级策略下都不该放行',
  )
}


// ══════════════════════════════════════════════════════════════════════
// 生命周期故障注入（身份漂移 / 降级 / 状态表破损）
// 每条都断言「最终状态 + 副作用」，不是只断言「没抛异常」。
// ══════════════════════════════════════════════════════════════════════

// ── 20. 真实身份漂移：只挪行号、不重新固化，内容签名必须接管 ────────────
// 既有的 status.test 第 8 步漂移后马上又跑了一次 consolidate，
// 而 consolidate 只在 append 时写新行、不会改写已有记录的 source_id，
// 所以那条路径其实更接近「重新对齐」而不是「漂移」。这里只挪文件、不重跑固化。
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-drift-'))
  const mem = path.join(d, 'memory')
  const sdir = path.join(mem, '记忆')
  fs.mkdirSync(sdir, { recursive: true })
  const dlg = path.join(d, '对话记录.md')
  const sfile = path.join(sdir, 'structured.jsonl')
  const wfile = path.join(sdir, '.watermark.json')
  const body = [
    '## 2026-10-20',
    '',
    '### 数据库选型',
    '',
    '数据库统一使用 PostgreSQL 15 作为主库，连接串走环境变量注入，不写死在代码里，迁移脚本放 migrations 目录。',
    '',
    '### 部署位置',
    '',
    '服务部署在测试机 10.0.0.5 上，先跑一周看看稳定性，没有问题再切到正式环境去，配置一起迁。',
    '',
  ].join('\n')
  fs.writeFileSync(dlg, body, 'utf8')
  consolidate({ dialogueFile: dlg, outputFile: sfile, watermarkFile: wfile })

  const dcfg = {
    memoryRoot: mem,
    dialogueFile: dlg,
    structuredFile: sfile,
    topK: 5,
    minCoverage: 0.1,
    minMatched: 1,
    minRatio: 0.1,
    halfLifeDays: 30,
  }
  const readD = () =>
    fs.readFileSync(sfile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const writeD = (rs) => fs.writeFileSync(sfile, rs.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')

  let drs = readD()
  const oldSection = sections(fs.readFileSync(dlg, 'utf8')).find((s) => s.text.includes('PostgreSQL 15'))
  assert.ok(oldSection, '对话小节可切分')
  const oldRecord = drs.find((r) => r.quote.includes('PostgreSQL 15'))
  assert.equal(oldRecord.source_id, 'dialogue:' + oldSection.line, '固化时的坐标与物理行号一致')
  drs.find((r) => r.id === oldRecord.id).status = 'superseded'
  writeD(drs)

  // 在文件最前面插一节，把后面所有小节的行号整体往后推；故意不重新固化
  const prefix =
    '## 2026-10-19\n\n### 补写的一节\n\n这是后来补写在最前面的一段内容，用来把后面所有小节的行号整体往后推，内容和别的节完全不同。\n\n'
  fs.writeFileSync(dlg, prefix + body, 'utf8')
  const drifted = sections(fs.readFileSync(dlg, 'utf8')).find((s) => s.text.includes('PostgreSQL 15'))
  assert.ok(drifted.line > oldSection.line, '物理行号确实漂了')

  const driftMap = loadStatusMap({ structuredFile: sfile })
  assert.equal(driftMap.degraded, false, '纯漂移不是状态表损坏')
  assert.equal(driftMap.bySourceId.has('dialogue:' + drifted.line), false, '状态表里没有漂移后的新坐标')
  assert.equal(
    resolveEntryStatus({ text: drifted.text, sourceId: 'dialogue:' + drifted.line }, driftMap),
    'superseded',
    '完整内容哈希接管：行号漂了仍然判定已取代',
  )
  assert.equal(
    resolveEntryStatus({ text: drifted.text + '新增的一句', sourceId: 'dialogue:' + drifted.line }, driftMap),
    null,
    '正文改了就是另一条记忆，状态不跟着走（已知限制，锁死行为）',
  )

  invalidateMemoryCache()
  const driftText = recall(dcfg, '数据库选型 PostgreSQL 15', Date.now() + 5000)
    .map((h) => h.entry.text)
    .join('\n')
  assert.ok(!driftText.includes('PostgreSQL 15'), '漂移后召回端仍然不放出被取代的正文')
  invalidateMemoryCache()
  const deployText = recall(dcfg, '部署位置 测试机', Date.now() + 5000)
    .map((h) => h.entry.text)
    .join('\n')
  assert.ok(deployText.includes('10.0.0.5'), '漂移后其他有效小节照常召回')

  // 导航通道当前的输入形状：summary.mjs 的 buildNav 只传行号，不传正文。
  // 解析器拿不到内容身份时只能回落坐标，坐标一漂就 null —— 这是「导航复活」的根因。
  // 修在 summary.mjs（把 entry.raw 当 text 传进来）；这里把两边都锁成规格。
  assert.equal(
    resolveEntryStatus(
      { contentId: undefined, text: undefined, sourceId: 'dialogue:' + drifted.line, id: 'dialogue:' + drifted.line },
      driftMap,
    ),
    null,
    '只给坐标时状态会丢（导航通道缺内容身份的根因）',
  )
  assert.equal(
    resolveEntryStatus({ text: drifted.text, sourceId: 'dialogue:' + drifted.line }, driftMap),
    'superseded',
    '补上正文就恢复正确判定（summary.mjs 修法验证）',
  )

  fs.rmSync(d, { recursive: true, force: true })
}

// ── 21. 降级：缺 status 的 legacy 记录不能冒充显式 active ────────────────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-degrade-'))
  const mem = path.join(d, 'memory')
  const sdir = path.join(mem, '记忆')
  fs.mkdirSync(sdir, { recursive: true })
  const dlg = path.join(d, '对话记录.md')
  const sfile = path.join(sdir, 'structured.jsonl')
  const wfile = path.join(sdir, '.watermark.json')
  const legacyTitle = '旧的迁移方案'
  const activeTitle = '现在的部署流程'
  const legacyBody = '旧的迁移方案是先手工导出再导入，中间还要停一次服务，流程很长而且容易出错，现在已经不用了。'
  const activeBody = '现在的部署流程是推镜像之后滚动更新，全程不停服务，回滚只需要把镜像标签切成上一个版本就行。'
  const body = [
    '## 2026-10-21',
    '',
    '### ' + legacyTitle,
    '',
    legacyBody,
    '',
    '### ' + activeTitle,
    '',
    activeBody,
    '',
  ].join('\n')
  fs.writeFileSync(dlg, body, 'utf8')
  consolidate({ dialogueFile: dlg, outputFile: sfile, watermarkFile: wfile })

  const readD = () =>
    fs.readFileSync(sfile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const writeD = (rs) => fs.writeFileSync(sfile, rs.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  const dcfg = {
    memoryRoot: mem,
    dialogueFile: dlg,
    structuredFile: sfile,
    topK: 5,
    minCoverage: 0.1,
    minMatched: 1,
    minRatio: 0.1,
    halfLifeDays: 30,
    enableMemoryNav: true,
    enableSanitize: true,
  }

  let drs = readD()
  const legacyRec = drs.find((r) => r.quote.includes('手工导出'))
  assert.ok(legacyRec, '旧迁移方案已固化')
  delete drs.find((r) => r.id === legacyRec.id).status // 退化成没有 status 的旧记录
  writeD(drs)
  const legacyText = sections(fs.readFileSync(dlg, 'utf8')).find((s) => s.text.includes('手工导出')).text
  const activeText = sections(fs.readFileSync(dlg, 'utf8')).find((s) => s.text.includes('滚动更新')).text

  // 健康状态表：legacy 照常放行（契约要求的向后兼容）
  const healthyMap = loadStatusMap({ structuredFile: sfile })
  assert.equal(healthyMap.degraded, false)
  assert.equal(resolveEntryStatus({ text: legacyText }, healthyMap), 'active', '健康表里 legacy 仍是可召回的 active')
  assert.equal(healthyMap.legacyContentIds.has(legacyRec.id), true, '表里能认出这条是 legacy')
  invalidateMemoryCache()
  assert.ok(
    recall(dcfg, '手工导出 迁移 停服务', Date.now() + 5000).some((h) => h.entry.text.includes('手工导出')),
    '健康状态下 legacy 记录照常召回',
  )

  // 注入一条截断行让状态表降级
  fs.appendFileSync(sfile, '{"id":"mem-truncated","source_id":"dialogue:9","status":"active"', 'utf8')
  const degradedMap = loadStatusMap({ structuredFile: sfile })
  assert.equal(degradedMap.degraded, true, '截断行让状态表降级')
  assert.equal(degradedMap.reason, 'partial_corrupt')

  assert.equal(
    resolveEntryStatus({ text: legacyText }, degradedMap),
    LEGACY_UNVERIFIED,
    '降级时 legacy 返回哨兵，不再冒充显式 active',
  )
  assert.equal(resolveEntryStatus({ text: activeText }, degradedMap), 'active', '显式 active 不受影响')
  assert.equal(isRecallable(LEGACY_UNVERIFIED, { degraded: true }), false, '哨兵默认不可召回')
  assert.equal(isRecallable(LEGACY_UNVERIFIED, { degraded: true, conservative: false }), true, '显式关掉保守才放行')

  const filtered = filterRecallableEntries(
    [{ text: legacyText }, { text: activeText }],
    degradedMap,
    { conservative: true },
  )
  assert.deepEqual(
    filtered.recallable.map((e) => e.text),
    [activeText],
    '降级过滤后只剩显式 active 的那条',
  )
  assert.equal(filtered.legacySuppressed, 1, '准确记账被压掉的 legacy 条数')
  assert.equal(filtered.unverified, 1)

  // 召回端：legacy 消失、显式 active 仍在
  invalidateMemoryCache()
  const degradedHits = recall(dcfg, '手工导出 导入 容易出错', Date.now() + 5000)
  assert.equal(degradedHits.length, 0, '降级时 legacy 记录不召回')
  invalidateMemoryCache()
  assert.ok(
    recall(dcfg, '滚动更新 镜像标签', Date.now() + 5000).some((h) => h.entry.text.includes('滚动更新')),
    '降级时显式 active 记录照常召回',
  )

  // 导航端必须和召回给同一个答案（否则旧决策会从导航漏回来）
  clearSummaryCache()
  const navDegraded = buildNav(dcfg)
  assert.ok(!navDegraded.includes(legacyTitle), '降级时 legacy 小节不进导航')
  assert.ok(navDegraded.includes(activeTitle), '降级时有效小节仍在导航里')

  // 修好状态表之后 legacy 立刻恢复，说明降级只是临时闸门，不是永久删除
  writeD(
    fs
      .readFileSync(sfile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null // 故意注入的截断行，修表时丢掉
        }
      })
      .filter(Boolean),
  )
  invalidateMemoryCache()
  assert.ok(
    recall(dcfg, '手工导出 迁移 停服务', Date.now() + 5000).some((h) => h.entry.text.includes('手工导出')),
    '状态表修复后 legacy 记录恢复召回',
  )

  fs.rmSync(d, { recursive: true, force: true })
}

// ── 22. contentId 与正文哈希矛盾：取更严的一侧，不许靠 content_id 洗白 ──
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-conflict-'))
  const cfile = path.join(d, 'conflict.jsonl')
  const textX = '### 仍在使用的现行方案\n\n现行方案是这一套，所有环境都按它来配置和部署，文档也已经同步。'
  const textY = '### 已被淘汰的历史方案\n\n历史方案是另外一套，维护成本太高，已经整体替换掉了，不再使用。'
  const X = { id: idOf(textX), source_id: 'dialogue:1', status: 'active' }
  const Y = { id: idOf(textY), source_id: 'dialogue:2', status: 'superseded' }
  fs.writeFileSync(cfile, [X, Y].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const cmap = loadStatusMap({ structuredFile: cfile })
  assert.equal(cmap.degraded, false)

  assert.equal(
    resolveEntryStatus({ contentId: X.id, text: textY }, cmap),
    'superseded',
    'content_id 指向有效记录、正文却是已淘汰内容：按更严的一侧判定',
  )
  assert.equal(
    resolveEntryStatus({ contentId: Y.id, text: textX }, cmap),
    'superseded',
    'content_id 指向已淘汰记录、正文有效：同样按更严的一侧判定',
  )
  assert.equal(resolveEntryStatus({ contentId: X.id, text: textX }, cmap), 'active', '两边一致时正常放行')
  assert.equal(
    resolveEntryStatus({ contentId: X.id, text: '一段和状态表毫无关系的正文，内容哈希根本对不上。' }, cmap),
    'active',
    '正文对不上任何记录时不该误伤 content_id 的有效身份',
  )
  assert.equal(
    resolveEntryStatus({ contentId: 'mem-not-in-table', text: textY }, cmap),
    'superseded',
    '未知 content_id 不能绕过正文哈希',
  )
  fs.rmSync(d, { recursive: true, force: true })
}

// ── 23. 截断 / 非法 status 的最终状态与副作用 ──────────────────────────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-broken-'))
  const bfile = path.join(d, 'broken.jsonl')
  const tActive = '### 有效记录一\n\n这条记录状态完整，应该一直被当作有效记忆来用，不受同文件坏行影响。'
  const tBadEnum = '### 状态字段坏掉的记录\n\n这条记录写了非法状态枚举，整条必须被丢弃，不能悄悄改成 active 放行。'
  const tActive2 = '### 有效记录二\n\n另一条状态完整的记录，同样应该在破损状态表里继续维持显式 active 身份。'
  const tCut = '### 被截断的半条记录\n\n这条记录只写了一半就被截断了，绝不能当成有效 active 记录被收进状态表。'
  const lines = [
    JSON.stringify({ id: idOf(tActive), source_id: 'dialogue:1', status: 'active' }),
    JSON.stringify({ id: idOf(tBadEnum), source_id: 'dialogue:2', status: 'deleted' }),
    JSON.stringify({ id: idOf(tActive2), source_id: 'dialogue:3', status: 'active' }),
    '{"id":"' + idOf(tCut) + '","source_id":"dialogue:4","status":"active"',
  ]
  fs.writeFileSync(bfile, lines.join('\n'), 'utf8')
  const bmap = loadStatusMap({ structuredFile: bfile })

  assert.equal(bmap.degraded, true, '坏行与非法枚举都必须触发降级')
  assert.equal(bmap.reason, 'partial_corrupt')
  assert.equal(bmap.syntaxErrors, 1, '准确统计 1 行截断')
  assert.equal(bmap.schemaErrors, 1, '准确统计 1 行非法 status')
  assert.equal(bmap.validRecords, 2, '2 条记录有效')
  assert.equal(bmap.totalRecords, 4, '解析尝试 4 行')
  assert.equal(bmap.brokenLines, 2)
  assert.equal(bmap.byContentId.has(idOf(tCut)), false, '被截断的记录没有被当成 active 收进状态表')
  assert.equal(bmap.byContentId.has(idOf(tBadEnum)), false, '非法 status 的整条记录被丢弃，不是改成 active')

  assert.equal(resolveEntryStatus({ text: tCut }, bmap), null, '截断记录没有状态，按未受管理处理')
  assert.equal(isRecallable(null, { degraded: true }), false, '降级时未受管理的记录不可召回')
  assert.equal(resolveEntryStatus({ text: tActive }, bmap), 'active')
  assert.equal(isRecallable('active', { degraded: true }), true, '显式 active 在降级时仍然可用')

  const bfilter = filterRecallableEntries([{ text: tCut }, { text: tBadEnum }, { text: tActive }], bmap, {
    conservative: true,
  })
  assert.deepEqual(bfilter.recallable.map((e) => e.text), [tActive], '降级过滤后只剩显式 active')
  assert.equal(bfilter.unverified, 2, '截断与非法枚举两条都记作 unverified')
  fs.rmSync(d, { recursive: true, force: true })
}

// ── 24. 悬空 supersedes 的副作用：不污染自己，也不凭空造出目标 ──────────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-dangling-'))
  const file = path.join(d, 'dangling.jsonl')
  const t1 = '### 现行部署目标\n\n现在部署到生产机 10.0.0.9，旧的测试机已经停用，配置文件也一起迁过去了。'
  const t2 = '### 另外一个主题\n\n这一节和部署无关，写的是日志收集和轮转策略，按天切割保留七天。'
  const t3 = '### 没有状态标记的历史条目\n\n这条记录没有 status 字段，属于旧版本固化产物，在健康表里应该照常可召回。'
  const r1 = { id: idOf(t1), source_id: 'dialogue:1', status: 'active', supersedes: 'mem-ghost' }
  const r2 = { id: idOf(t2), source_id: 'dialogue:2', status: 'active' }
  const r3 = { id: idOf(t3), source_id: 'dialogue:3' }
  fs.writeFileSync(file, [r1, r2, r3].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const dmap = loadStatusMap({ structuredFile: file })

  assert.equal(dmap.degraded, true, '悬空引用触发降级')
  assert.equal(dmap.reason, 'dangling_reference')
  assert.equal(dmap.danglingRefs, 1)
  assert.equal(dmap.byContentId.get(r1.id), 'active', '指向不存在目标的记录自己仍然是 active')
  assert.equal(dmap.byContentId.has('mem-ghost'), false, '不存在的目标不会被凭空写进内容表')
  assert.equal(
    [...dmap.bySourceId.values()].includes('superseded'),
    false,
    '悬空引用不会把某个坐标伪造成 superseded',
  )
  assert.equal(resolveEntryStatus({ text: t1 }, dmap), 'active')
  assert.equal(resolveEntryStatus({ text: t3 }, dmap), LEGACY_UNVERIFIED, '降级时 legacy 记录被压掉')

  const dfilter = filterRecallableEntries([{ text: t1 }, { text: t2 }, { text: t3 }], dmap, {
    conservative: true,
  })
  assert.equal(dfilter.recallable.length, 2, '两条显式 active 保留')
  assert.equal(dfilter.legacySuppressed, 1, '一条 legacy 被压掉')
  fs.rmSync(d, { recursive: true, force: true })
}

// ── 25. 坐标冲突是非致命诊断：内容哈希优先，纯坐标保守压掉 ──────────────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-coord-'))
  const file = path.join(d, 'coord.jsonl')
  const tNew = '### 同一个物理行上的新内容\n\n改过正文之后重新固化，落在了同一个物理行坐标上，这是正常生命周期。'
  const tOld = '### 同一个物理行上的旧内容\n\n旧正文已经被改写掉了，但旧记录还留在状态表里等着被追溯，不该再被召回。'
  const rNew = { id: idOf(tNew), source_id: 'dialogue:7', status: 'active' }
  const rOld = { id: idOf(tOld), source_id: 'dialogue:7', status: 'superseded' }
  fs.writeFileSync(file, [rNew, rOld].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const cmap = loadStatusMap({ structuredFile: file })

  assert.equal(cmap.degraded, false, '坐标冲突不按损坏处理，不然改一次正文就全表停用')
  assert.equal(cmap.reason, 'ok')
  assert.equal(cmap.coordinateConflicts, 1, '坐标冲突要记账')
  assert.equal(cmap.bySourceId.get('dialogue:7'), 'superseded', '冲突坐标保守归约为 superseded')
  assert.equal(resolveEntryStatus({ text: tNew }, cmap), 'active', '新内容靠内容哈希照样可用')
  assert.equal(
    resolveEntryStatus({ sourceId: 'dialogue:7' }, cmap),
    'superseded',
    '只按坐标查（导航形状）时保守压掉，宁可不显示也不放旧决策',
  )
  fs.rmSync(d, { recursive: true, force: true })
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('status tests passed')
