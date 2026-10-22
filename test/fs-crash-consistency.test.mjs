import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  FS_CORRUPT,
  FS_DENIED,
  FS_IO,
  FS_MISSING,
  FsSafeError,
  appendJsonlDurable,
  assertSafeWritePath,
  atomicWriteFile,
  atomicWriteJson,
  classifyFsError,
  fsyncDirSync,
  isAtomicTempName,
  readJsonlTyped,
  readJsonTyped,
  readTextTyped,
  reconcileWatermark,
  resolveWriteTarget,
  sweepStaleTemps,
  tempArtifactFor,
} from '../fs-safe.mjs'
import { consolidate } from '../consolidate.mjs'

// ── 极简测试脚手架 ─────────────────────────────────────────────────────
const passed = []
const failed = []
async function test(name, fn) {
  try {
    await fn()
    passed.push(name)
    console.log('ok   ' + name)
  } catch (error) {
    failed.push({ name, error })
    console.log('FAIL ' + name + '\n     ' + String((error && error.message) || error).split('\n').join('\n     '))
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-crash-'))
let seq = 0
function workDir(label) {
  seq += 1
  const dir = path.join(root, String(seq) + '-' + label)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => isAtomicTempName(name))
}
function injected(code) {
  const error = new Error('injected ' + code)
  error.code = code
  return error
}
function readText(file) {
  return fs.readFileSync(file, 'utf8')
}
// 软链在 Windows 上需要开发者模式/管理员权限。拿不到就跳过软链组，别把环境限制算成失败。
let symlinkOk = true
try {
  const probe = path.join(root, 'probe-link')
  fs.symlinkSync(path.join(root, 'probe-target'), probe, 'file')
  fs.unlinkSync(probe)
} catch {
  symlinkOk = false
}
const skipNote = '（本机无创建符号链接的权限，跳过）'

// ═══ A. 四种失败语义必须分得开 ═════════════════════════════════════════
await test('A1 文件缺失：kind=missing，不冒充空内容', () => {
  const dir = workDir('a1')
  const res = readTextTyped(path.join(dir, 'nope.json'))
  assert.equal(res.ok, false)
  assert.equal(res.kind, FS_MISSING)
  assert.equal(res.missing, true)
  assert.equal(res.text, '')
  assert.ok(res.error instanceof FsSafeError)
  assert.equal(res.error.recoverable, true)
})

await test('A2 权限拒绝：kind=denied，可重建=false', () => {
  const dir = workDir('a2')
  const file = path.join(dir, 'locked.json')
  fs.writeFileSync(file, '{"ok":true}', 'utf8')
  const impl = { ...fs, readFileSync: () => { throw injected('EACCES') } }
  const res = readTextTyped(file, { fs: impl })
  assert.equal(res.ok, false)
  assert.equal(res.kind, FS_DENIED)
  assert.equal(res.missing, false, '权限拒绝绝不能被当成文件缺失')
  assert.equal(res.error.recoverable, false, 'denied 不能靠覆写修好')
})

await test('A3 JSON 损坏：kind=corrupt，且 points 到语法错误', () => {
  const dir = workDir('a3')
  const file = path.join(dir, 'wm.json')
  fs.writeFileSync(file, '{"ids": ["a", ', 'utf8')
  const res = readJsonTyped(file)
  assert.equal(res.ok, false)
  assert.equal(res.kind, FS_CORRUPT)
  assert.equal(res.value, undefined, '损坏的 JSON 不许退化成 {}')
  assert.match(res.error.message, /JSON 解析失败/)
  assert.equal(res.error.recoverable, true)
})

await test('A4 空文件算 corrupt，不算 missing', () => {
  const dir = workDir('a4')
  const file = path.join(dir, 'empty.json')
  fs.writeFileSync(file, '', 'utf8')
  const res = readJsonTyped(file)
  assert.equal(res.ok, false)
  assert.equal(res.kind, FS_CORRUPT)
  assert.equal(res.missing, false)
})

await test('A5 I/O 故障：kind=io，和 denied / missing 区分开', () => {
  const dir = workDir('a5')
  const file = path.join(dir, 'bad-sector.json')
  fs.writeFileSync(file, '{}', 'utf8')
  const impl = { ...fs, readFileSync: () => { throw injected('EIO') } }
  const res = readTextTyped(file, { fs: impl })
  assert.equal(res.kind, FS_IO)
  assert.equal(res.error.recoverable, false)
})

await test('A6 目标为目录：分类跨平台一致（恒为 io/EISDIR）', () => {
  const dir = workDir('a6')
  const res = readTextTyped(dir)
  assert.equal(res.ok, false)
  assert.equal(res.kind, FS_IO)
  assert.equal(res.error.code, 'EISDIR')
})

await test('A7 同一个 ENOENT 在不同阶段含义不同', () => {
  const read = classifyFsError(injected('ENOENT'), { phase: 'read' })
  const renamed = classifyFsError(injected('ENOENT'), { phase: 'rename' })
  assert.equal(read.kind, FS_MISSING, '读取时 ENOENT = 文件不存在')
  assert.equal(renamed.kind, FS_IO, 'rename 时 ENOENT = 临时文件丢了，属于 I/O 故障')
})

await test('A8 JSONL 坏行被点名，但不拖垮整份存档', () => {
  const dir = workDir('a8')
  const file = path.join(dir, 'store.jsonl')
  fs.writeFileSync(file, '{"id":"a"}\n{坏行}\n{"id":"b"}\n', 'utf8')
  const res = readJsonlTyped(file)
  assert.equal(res.ok, true)
  assert.equal(res.records.length, 2)
  assert.equal(res.corruptLines.length, 1)
  assert.equal(res.corruptLines[0].line, 2)
  assert.equal(res.kind, FS_CORRUPT)
})

// ═══ B. 原子写入的失败态与磁盘终态 ═════════════════════════════════════
await test('B1 写入失败时磁盘不变，且不留临时文件', () => {
  const dir = workDir('b1')
  const target = path.join(dir, 'state.json')
  const original = '{"generation":1}\n'
  fs.writeFileSync(target, original, 'utf8')
  const impl = { ...fs, renameSync: () => { throw injected('EPERM') } }
  let caught = null
  try {
    atomicWriteJson(target, { generation: 2 }, 2, { fs: impl, retries: 1 })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof FsSafeError, '必须抛出分类错误')
  assert.equal(caught.kind, FS_DENIED)
  assert.equal(readText(target), original, '磁盘上必须还是旧内容')
  assert.deepEqual(leftovers(dir), [], '失败后不许留下临时文件')
})

await test('B2 临时名冲突（O_EXCL 抢占）时换名重试，最终写成功', () => {
  const dir = workDir('b2')
  const target = path.join(dir, 'state.json')
  let opens = 0
  const realOpen = fs.openSync.bind(fs)
  const impl = {
    ...fs,
    openSync: (p, flags, ...rest) => {
      if (flags === 'wx' && opens < 2) {
        opens += 1
        throw injected('EEXIST')
      }
      return realOpen(p, flags, ...rest)
    },
  }
  const written = atomicWriteJson(target, { generation: 7 }, 2, { fs: impl })
  assert.equal(written, target)
  assert.equal(opens, 2, '必须真的撞了两次并重试')
  assert.deepEqual(JSON.parse(readText(target)), { generation: 7 })
  assert.deepEqual(leftovers(dir), [])
})

await test('B3 半成品临时文件永远读不到：旧内容对读者保持完整', () => {
  const dir = workDir('b3')
  const target = path.join(dir, 'state.json')
  atomicWriteJson(target, { generation: 1 })
  // 模拟「临时文件写完了，rename 之前进程被硬杀」
  const half = tempArtifactFor(target, { pid: 424242, nonce: 'aaaaaaaaaaaa' })
  fs.writeFileSync(half, '{"generation":2,"torn":tr', 'utf8')
  assert.ok(isAtomicTempName(path.basename(half)))
  const res = readJsonTyped(target)
  assert.equal(res.ok, true, '读者看到的仍是上一次完整内容')
  assert.deepEqual(res.value, { generation: 1 })
})

await test('B4 崩溃残留可被清扫，且不误删别人的临时文件', () => {
  const dir = workDir('b4')
  const target = path.join(dir, 'state.json')
  atomicWriteJson(target, { ok: true })
  const stale = tempArtifactFor(target, { pid: 99999, nonce: 'bbbbbbbbbbbb' })
  const fresh = tempArtifactFor(target, { pid: 88888, nonce: 'cccccccccccc' })
  fs.writeFileSync(stale, 'old', 'utf8')
  fs.writeFileSync(fresh, 'new', 'utf8')
  fs.writeFileSync(path.join(dir, 'notes.tmp'), 'user file', 'utf8')
  const old = new Date(Date.now() - 3600_000)
  fs.utimesSync(stale, old, old)

  const report = sweepStaleTemps(dir, { olderThanMs: 60_000 })
  assert.deepEqual(report.removed, [path.basename(stale)], '只清扫过期的那一个')
  assert.deepEqual(report.kept, [path.basename(fresh)])
  assert.equal(report.errors.length, 0)
  assert.equal(fs.existsSync(stale), false, '磁盘上陈旧临时文件已消失')
  assert.equal(fs.existsSync(fresh), true, '刚创建的临时文件必须留着')
  assert.equal(readText(path.join(dir, 'notes.tmp')), 'user file', '用户自己的 .tmp 不许动')
  assert.deepEqual(JSON.parse(readText(target)), { ok: true })
})

await test('B5 dryRun 只报告不落手', () => {
  const dir = workDir('b5')
  const stale = tempArtifactFor(path.join(dir, 'x.json'), { pid: 777, nonce: 'dddddddddddd' })
  fs.writeFileSync(stale, 'x', 'utf8')
  const old = new Date(Date.now() - 3600_000)
  fs.utimesSync(stale, old, old)
  const report = sweepStaleTemps(dir, { olderThanMs: 1000, dryRun: true })
  assert.deepEqual(report.removed, [])
  assert.equal(report.matched, 1)
  assert.equal(fs.existsSync(stale), true, 'dryRun 不许删东西')
})

await test('B6 内容类型不合法时拒绝，且不产生副作用', () => {
  const dir = workDir('b6')
  const target = path.join(dir, 'state.json')
  assert.throws(() => atomicWriteFile(target, { not: 'a string' }), /必须是 string 或 Buffer/)
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(leftovers(dir), [])
})

await test('B7 目录 fsync 的平台语义诚实', () => {
  const dir = workDir('b7')
  const done = fsyncDirSync(dir)
  if (process.platform === 'win32') assert.equal(done, false, 'Windows 不能目录 fsync，必须如实返回 false')
  else assert.equal(done, true)
})

await test('B8 真并发：4 个进程各写 25 次，终态必须是某个完整值', async () => {
  const dir = workDir('b8')
  const target = path.join(dir, 'contended.json')
  const moduleUrl = new URL('../fs-safe.mjs', import.meta.url).href
  const rounds = 25
  const script =
    "import('" + moduleUrl + "').then((m) => { for (let i = 0; i < " + rounds +
    '; i += 1) { m.atomicWriteFile(process.argv[1], JSON.stringify({ pid: process.pid, round: i }), "utf8") } })'
  const runners = []
  for (let n = 0; n < 4; n += 1) {
    runners.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('child exit ' + code + ': ' + stderr))))
      }),
    )
  }
  await Promise.all(runners)
  const final = readJsonTyped(target)
  assert.equal(final.ok, true, '并发写完必须还是合法 JSON，不能是拼接碎片')
  assert.equal(typeof final.value.round, 'number')
  assert.ok(final.value.round >= 0 && final.value.round < rounds)
  assert.deepEqual(leftovers(dir), [], '并发写完不许留下任何临时文件')
})

// ═══ C. 符号链接边界 ═══════════════════════════════════════════════════
await test('C1 悬空软链：写到链接目标上，链接本身保留', () => {
  if (!symlinkOk) return console.log('     ' + skipNote)
  const dir = workDir('c1')
  const realDir = workDir('c1-target')
  const linkPath = path.join(dir, 'store.json')
  const targetPath = path.join(realDir, 'actual.json')
  fs.symlinkSync(targetPath, linkPath, 'file')
  assert.equal(fs.existsSync(targetPath), false, '起点必须是悬空链接')
  atomicWriteJson(linkPath, { via: 'symlink' })
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, '链接不许被替换成普通文件')
  assert.deepEqual(JSON.parse(readText(targetPath)), { via: 'symlink' }, '内容必须落在链接目标上')
})

await test('C2 链接成环：抛 ELOOP 并拒绝写入，磁盘不动', () => {
  if (!symlinkOk) return console.log('     ' + skipNote)
  const dir = workDir('c2')
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'b.json')
  fs.symlinkSync(b, a, 'file')
  fs.symlinkSync(a, b, 'file')
  let caught = null
  try {
    atomicWriteJson(a, { loop: true })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof FsSafeError)
  assert.equal(caught.kind, FS_IO)
  assert.equal(caught.code, 'ELOOP')
  assert.equal(fs.lstatSync(a).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(b).isSymbolicLink(), true)
  assert.deepEqual(leftovers(dir), [])
})

await test('C3 指向受保护目录的悬空软链：仍然拦得住', () => {
  if (!symlinkOk) return console.log('     ' + skipNote)
  const dir = workDir('c3')
  const memoryRoot = path.join(dir, 'memory')
  fs.mkdirSync(memoryRoot, { recursive: true })
  const linkPath = path.join(dir, 'escape.json')
  fs.symlinkSync(path.join(memoryRoot, 'not-created-yet.json'), linkPath, 'file')
  assert.throws(() => assertSafeWritePath(linkPath, memoryRoot), /禁止写入受保护目录/)
  assert.throws(() => atomicWriteJson(linkPath, { x: 1 }, 2, { forbiddenRoots: [memoryRoot] }), /禁止写入受保护目录/)
  assert.equal(fs.existsSync(path.join(memoryRoot, 'not-created-yet.json')), false, '受保护目录里不许出现任何文件')
})

await test('C4 普通相对路径穿越仍然拦得住', () => {
  const dir = workDir('c4')
  const memoryRoot = path.join(dir, 'memory')
  fs.mkdirSync(memoryRoot, { recursive: true })
  const traversal = path.join(dir, 'other', '..', 'memory', 'hacked.jsonl')
  assert.throws(() => assertSafeWritePath(traversal, memoryRoot), /禁止写入受保护目录/)
})

await test('C5 解析软链失败时 fail closed（拒绝而不是猜）', () => {
  const dir = workDir('c5')
  const memoryRoot = path.join(dir, 'memory')
  fs.mkdirSync(memoryRoot, { recursive: true })
  const impl = { ...fs, lstatSync: () => { throw injected('ELOOP') } }
  // 用一个不存在的平台无关方式制造解析失败：链接循环注入
  const target = path.join(dir, 'x.json')
  const original = fs.lstatSync
  fs.lstatSync = () => { throw injected('ELOOP') }
  try {
    assert.throws(() => assertSafeWritePath(target, memoryRoot), /无法解析目标路径/)
  } finally {
    fs.lstatSync = original
  }
  void impl
})

// ═══ D. 数据文件 ↔ 水位文件 的恢复一致性 ═══════════════════════════════
function seed(dir, ids, watermark) {
  const dataFile = path.join(dir, 'structured.jsonl')
  const watermarkFile = path.join(dir, 'watermark.json')
  fs.writeFileSync(dataFile, ids.map((id) => JSON.stringify({ id: id, text: 't-' + id })).join('\n') + '\n', 'utf8')
  if (watermark !== null) fs.writeFileSync(watermarkFile, JSON.stringify(watermark, null, 2) + '\n', 'utf8')
  return { dataFile, watermarkFile }
}
function wmIds(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).ids
}

await test('D1 水位落后于数据：用数据补齐，数据文件不动', () => {
  const dir = workDir('d1')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b', 'c'], { ids: ['a', 'b'] })
  const dataBefore = readText(dataFile)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'behind')
  assert.equal(res.repaired, true)
  assert.equal(res.written, true)
  assert.deepEqual(res.missingFromWatermark, ['c'])
  assert.deepEqual(wmIds(watermarkFile), ['a', 'b', 'c'])
  assert.equal(readText(dataFile), dataBefore, '水位对账绝不许改数据文件')
})

await test('D2 水位超前于数据（数据追加丢了）：丢掉幽灵 id', () => {
  const dir = workDir('d2')
  const { dataFile, watermarkFile } = seed(dir, ['a'], { ids: ['a', 'ghost1', 'ghost2'] })
  const dataBefore = readText(dataFile)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'ahead')
  assert.deepEqual(res.missingFromData, ['ghost1', 'ghost2'])
  assert.deepEqual(wmIds(watermarkFile), ['a'], '数据里没有的 id 不许继续留在水位里')
  assert.equal(readText(dataFile), dataBefore)
})

await test('D3 数据与水位都不完整（divergent）：以数据为准重建', () => {
  const dir = workDir('d3')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b', 'c'], { ids: ['a', 'zzz'] })
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'divergent')
  assert.deepEqual(wmIds(watermarkFile), ['a', 'b', 'c'])
})

await test('D4 水位文件缺失：从数据重建', () => {
  const dir = workDir('d4')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], null)
  assert.equal(fs.existsSync(watermarkFile), false)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'watermark_missing')
  assert.equal(res.written, true)
  assert.deepEqual(wmIds(watermarkFile), ['a', 'b'])
})

await test('D5 水位内容损坏：重建（不是当成空水位悄悄放弃）', () => {
  const dir = workDir('d5')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], null)
  fs.writeFileSync(watermarkFile, '{"ids": ["a", ', 'utf8')
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'watermark_corrupt')
  assert.equal(res.watermark.kind, FS_CORRUPT)
  assert.equal(res.written, true)
  assert.deepEqual(wmIds(watermarkFile), ['a', 'b'])
})

await test('D6 水位读不了（权限）：绝不覆写，保留现场', () => {
  const dir = workDir('d6')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], { ids: ['a'] })
  const before = readText(watermarkFile)
  const impl = {
    ...fs,
    readFileSync: (p, options) => {
      if (String(p) === watermarkFile) throw injected('EACCES')
      return fs.readFileSync(p, options)
    },
  }
  const res = reconcileWatermark({ dataFile, watermarkFile, fs: impl })
  assert.equal(res.status, 'watermark_unreadable')
  assert.equal(res.repaired, false, '读不到不等于可以重建')
  assert.equal(res.written, false)
  assert.equal(readText(watermarkFile), before, '磁盘上的水位必须一个字节都没变')
})

await test('D7 数据文件缺失：不碰水位、不去凭空造数据', () => {
  const dir = workDir('d7')
  const dataFile = path.join(dir, 'structured.jsonl')
  const watermarkFile = path.join(dir, 'watermark.json')
  fs.writeFileSync(watermarkFile, JSON.stringify({ ids: ['a', 'b'] }), 'utf8')
  const before = readText(watermarkFile)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'data_missing')
  assert.equal(res.repaired, false)
  assert.equal(readText(watermarkFile), before, '数据没了，水位是仅存的证据，不许删')
  assert.equal(fs.existsSync(dataFile), false)
})

await test('D8 数据文件有坏行：报出来但不自动收敛', () => {
  const dir = workDir('d8')
  const dataFile = path.join(dir, 'structured.jsonl')
  const watermarkFile = path.join(dir, 'watermark.json')
  fs.writeFileSync(dataFile, '{"id":"a"}\n{损坏行}\n', 'utf8')
  fs.writeFileSync(watermarkFile, JSON.stringify({ ids: ['a'] }), 'utf8')
  const before = readText(watermarkFile)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'data_corrupt')
  assert.equal(res.data.corruptLines.length, 1)
  assert.equal(readText(watermarkFile), before)
})

await test('D9 一致时一个字节都不写（mtime 不变）', () => {
  const dir = workDir('d9')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], { ids: ['a', 'b'] })
  const statBefore = fs.statSync(watermarkFile)
  const before = readText(watermarkFile)
  const res = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(res.status, 'consistent')
  assert.equal(res.repaired, false)
  assert.equal(res.written, false)
  assert.equal(readText(watermarkFile), before)
  assert.equal(fs.statSync(watermarkFile).mtimeMs, statBefore.mtimeMs, 'mtime 都没变才算真的没写')
})

await test('D10 dryRun 只算不写', () => {
  const dir = workDir('d10')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], { ids: ['a'] })
  const before = readText(watermarkFile)
  const res = reconcileWatermark({ dataFile, watermarkFile, dryRun: true })
  assert.equal(res.status, 'behind')
  assert.equal(res.repaired, true)
  assert.equal(res.written, false)
  assert.equal(readText(watermarkFile), before)
})

await test('D11 重复对账幂等：第二次就是 consistent', () => {
  const dir = workDir('d11')
  const { dataFile, watermarkFile } = seed(dir, ['a', 'b'], { ids: ['a'] })
  assert.equal(reconcileWatermark({ dataFile, watermarkFile }).status, 'behind')
  const second = reconcileWatermark({ dataFile, watermarkFile })
  assert.equal(second.status, 'consistent')
  assert.equal(second.written, false)
  assert.deepEqual(wmIds(watermarkFile), ['a', 'b'])
})

await test('D12 重建水位时保留 lastHash / seen 等额外字段', () => {
  const dir = workDir('d12')
  const dataFile = path.join(dir, 'summaries.jsonl')
  const watermarkFile = path.join(dir, 'summaries.jsonl.watermark.json')
  fs.writeFileSync(dataFile, '{"id":"sum-k1"}\n{"id":"sum-k2"}\n', 'utf8')
  fs.writeFileSync(watermarkFile, JSON.stringify({ seen: ['k1'], lastHash: 'hash-abc', count: 1 }), 'utf8')
  const res = reconcileWatermark({
    dataFile,
    watermarkFile,
    readIds: (records) => records.map((r) => String(r.id).replace(/^sum-/, '')),
    readWatermarkIds: (wm) => (Array.isArray(wm.seen) ? wm.seen : []),
    renderWatermark: (ids, previous) => ({ ...previous, seen: [...ids], count: ids.length }),
  })
  assert.equal(res.status, 'behind')
  const after = JSON.parse(readText(watermarkFile))
  assert.deepEqual(after.seen, ['k1', 'k2'])
  assert.equal(after.lastHash, 'hash-abc', 'lastHash 这种不能从数据推出来的字段必须留着')
  assert.equal(after.count, 2)
})

// ═══ E. 与真实 consolidate 的端到端恢复 ════════════════════════════════
const DIALOGUE = [
  '## 2026-10-20',
  '',
  '### 部署机上跑的是生产配置',
  '',
  '部署机现在跑的是生产配置，地址是生产机 10.0.0.9，用的是 MySQL 8，端口 3306，这一行凑够四十个字符。',
  '',
  '### 代码缩进改成四个空格',
  '',
  '代码缩进规范从两个空格改成了四个空格，所有新提交都按四个空格来，这一行也凑够四十个字符。',
  '',
  '### 周会挪到周三下午',
  '',
  '周会时间从周一下午挪到了周三下午两点，会议室还是原来那间，这一行同样凑够四十个字符。',
  '',
].join('\n')

await test('E1 consolidate 重复跑三遍不产生重复行', () => {
  const dir = workDir('e1')
  const dialogueFile = path.join(dir, '对话记录.md')
  fs.writeFileSync(dialogueFile, DIALOGUE, 'utf8')
  const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
  const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')
  const first = consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(first.written, 3)
  const lines = readText(outputFile).split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  consolidate({ dialogueFile, outputFile, watermarkFile })
  consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(readText(outputFile).split('\n').filter(Boolean).length, 3, '重复操作必须幂等')
})

await test('E2 水位文件丢了：先对账修回来，再固化行数不变', () => {
  const dir = workDir('e2')
  const dialogueFile = path.join(dir, '对话记录.md')
  fs.writeFileSync(dialogueFile, DIALOGUE, 'utf8')
  const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
  const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')
  consolidate({ dialogueFile, outputFile, watermarkFile })
  const before = readText(outputFile)
  fs.unlinkSync(watermarkFile)
  const repaired = reconcileWatermark({ dataFile: outputFile, watermarkFile })
  assert.equal(repaired.status, 'watermark_missing')
  assert.equal(repaired.written, true)
  assert.equal(wmIds(watermarkFile).length, 3, '水位必须按数据里的 id 重建')
  consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(readText(outputFile), before, '修复后重跑不许追加任何记录')
  assert.equal(reconcileWatermark({ dataFile: outputFile, watermarkFile }).status, 'consistent')
})

await test('E5 水位丢了直接重跑也不重复（consolidate 自己的 id 去重安全网）', () => {
  const dir = workDir('e5')
  const dialogueFile = path.join(dir, '对话记录.md')
  fs.writeFileSync(dialogueFile, DIALOGUE, 'utf8')
  const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
  const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')
  consolidate({ dialogueFile, outputFile, watermarkFile })
  const before = readText(outputFile)
  fs.unlinkSync(watermarkFile)
  consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(readText(outputFile), before, '水位丢失后重跑不许追加任何记录')
  assert.equal(readText(outputFile).split('\n').filter(Boolean).length, 3)
  assert.equal(reconcileWatermark({ dataFile: outputFile, watermarkFile }).status, 'consistent')
})

await test('E3 水位损坏后仍能恢复：对账 → 再固化 → 行数不变', () => {
  const dir = workDir('e3')
  const dialogueFile = path.join(dir, '对话记录.md')
  fs.writeFileSync(dialogueFile, DIALOGUE, 'utf8')
  const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
  const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')
  consolidate({ dialogueFile, outputFile, watermarkFile })
  const before = readText(outputFile)
  fs.writeFileSync(watermarkFile, '', 'utf8')
  const repaired = reconcileWatermark({ dataFile: outputFile, watermarkFile })
  assert.equal(repaired.status, 'watermark_corrupt')
  assert.equal(wmIds(watermarkFile).length, 3)
  consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(readText(outputFile), before, '对账 + 重跑之后记录数不许变')
})

await test('E4 新小节出现时只追加新的那些', () => {
  const dir = workDir('e4')
  const dialogueFile = path.join(dir, '对话记录.md')
  fs.writeFileSync(dialogueFile, DIALOGUE, 'utf8')
  const outputFile = path.join(dir, 'memory', '记忆', 'structured.jsonl')
  const watermarkFile = path.join(dir, 'memory', '记忆', '.watermark.json')
  consolidate({ dialogueFile, outputFile, watermarkFile })
  const grown = DIALOGUE + '\n### 猫改名成糯米\n\n猫的名字从年糕改成了糯米，其他都没变，这一行也要凑够四十个字符才行。\n'
  fs.writeFileSync(dialogueFile, grown, 'utf8')
  const res = consolidate({ dialogueFile, outputFile, watermarkFile })
  assert.equal(res.written, 1, '只有新增的那一条该被写进去')
  assert.equal(readText(outputFile).split('\n').filter(Boolean).length, 4)
  assert.equal(reconcileWatermark({ dataFile: outputFile, watermarkFile }).status, 'consistent')
})

// ── 收尾 ───────────────────────────────────────────────────────────────
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {}

console.log('')
console.log(passed.length + '/' + (passed.length + failed.length) + ' passed')
if (failed.length) {
  for (const item of failed) console.log('FAILED: ' + item.name + ' :: ' + String((item.error && item.error.stack) || item.error))
  process.exitCode = 1
}
