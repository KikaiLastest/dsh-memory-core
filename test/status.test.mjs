import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recall } from '../index.js'
import { consolidate } from '../consolidate.mjs'
import { loadStatusMap } from '../status.mjs'

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

fs.rmSync(dir, { recursive: true, force: true })
console.log('status tests passed')
