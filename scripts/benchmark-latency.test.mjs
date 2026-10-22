/**
 * 基准脚本自测。
 *
 * 注意：文件名不放在 test/ 下，是因为 test/pack.test.mjs 要求 test/*.test.mjs
 * 必须全部串进 npm test；而 package.json 不归性能代理改。等集成方把
 * "node scripts/benchmark-latency.test.mjs" 加进 npm test 后，可以自由移动。
 *
 * 运行：node scripts/benchmark-latency.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  EXIT,
  DEFAULT_SEED,
  DEFAULT_PROBES,
  COLD_ROUNDS,
  HOT_ROUNDS,
  parseArgs,
  UsageError,
  makeRng,
  seededOrder,
  percentile,
  summarize,
  splitMarkdownEntries,
  auditSources,
  gateRealInputs,
  buildSyntheticCorpus,
  workloadDigest,
} from './lib/bench-utils.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(here)
const script = path.join(here, 'benchmark-latency.mjs')
let passed = 0
const temps = []

function test(name, fn) {
  fn()
  passed += 1
  console.log('  ok - ' + name)
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function realSource(filePath) {
  return [
    {
      id: 'dialogueFile',
      label: '对话记录文件',
      path: filePath,
      required: true,
      searchable: true,
      kind: 'file',
      format: 'markdown',
    },
  ]
}

function runCli(args, env) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...(env || {}) },
  })
  return {
    code: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    out: String(res.stdout || '') + String(res.stderr || ''),
    error: res.error ? String(res.error.message) : '',
  }
}

function lineWith(text, prefix) {
  return text.split('\n').find((line) => line.startsWith(prefix)) || ''
}

try {
  console.log('benchmark-latency tests')

  test('parseArgs 默认值与显式模式', () => {
    assert.equal(parseArgs([]).mode, null)
    assert.equal(parseArgs(['--mode=real']).mode, 'real')
    assert.equal(parseArgs(['--mode', 'synthetic']).mode, 'synthetic')
    assert.equal(parseArgs(['--mode=synthetic']).seed, DEFAULT_SEED)
    assert.equal(parseArgs(['--mode=real', '--seed', '7']).seed, 7)
    assert.equal(parseArgs(['--help']).help, true)
  })

  test('parseArgs 拒绝缺失/非法/未知参数', () => {
    assert.throws(() => parseArgs(['--mode']), UsageError)
    assert.throws(() => parseArgs(['--mode=']), UsageError)
    assert.throws(() => parseArgs(['--mode=auto']), UsageError)
    assert.throws(() => parseArgs(['--mode=real', '--seed=-1']), UsageError)
    assert.throws(() => parseArgs(['--mode=real', '--seed=abc']), UsageError)
    assert.throws(() => parseArgs(['--mode=real', '--seed=4294967296']), UsageError)
    assert.throws(() => parseArgs(['--mode=real', '--mode=synthetic']), UsageError)
    assert.throws(() => parseArgs(['--mode=real', '--unknown=1']), UsageError)
  })

  test('PRNG 与排列可复现', () => {
    const seqA = Array.from({ length: 8 }, makeRng(42))
    const seqB = Array.from({ length: 8 }, makeRng(42))
    const seqC = Array.from({ length: 8 }, makeRng(43))
    assert.deepEqual(seqA, seqB)
    assert.notDeepEqual(seqA, seqC)
    assert.ok(seqA.every((v) => v >= 0 && v < 1))

    const order = seededOrder(7, 5)
    assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4])
    assert.deepEqual(order, seededOrder(7, 5))
  })

  test('百分位数是线性插值且不依赖输入顺序', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
    assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 95) - 4.8) < 1e-12)
    assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 99) - 4.96) < 1e-12)
    assert.equal(percentile([42], 99), 42)
    assert.equal(percentile([5, 1, 3, 2, 4], 0), 1)
    assert.equal(percentile([5, 1, 3, 2, 4], 100), 5)
    assert.throws(() => percentile([], 50))
  })

  test('summarize 同时给 mean/P50/P95/P99', () => {
    const s = summarize([1, 2, 3, 4, 5])
    assert.equal(s.n, 5)
    assert.equal(s.mean, 3)
    assert.equal(s.p50, 3)
    assert.equal(s.min, 1)
    assert.equal(s.max, 5)
    assert.ok(Math.abs(s.p95 - 4.8) < 1e-12)
    assert.ok(Math.abs(s.p99 - 4.96) < 1e-12)
  })

  test('splitMarkdownEntries 与 recall 的 40 字符/表格规则一致', () => {
    const long = 'x'.repeat(60)
    const md = [
      '## 标题',
      '',
      '### 短条目',
      '',
      '太短',
      '',
      '### 长条目',
      '',
      long,
      '',
      '### 表格条目',
      '| a | b |',
      long,
    ].join('\n')
    const entries = splitMarkdownEntries(md)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].includes(long))
  })

  test('审计五态：present / missing / empty / 短内容为空', () => {
    const dir = tempDir('bench-audit-')
    const dialogue = path.join(dir, '对话记录.md')
    const longBody = '本地部署优化方案需要完整的实施步骤与验证标准，覆盖备份、回滚和回放。'
    writeFile(dialogue, '## 2026-01-01\n\n### 本地部署优化方案\n\n' + longBody + '\n')
    const memoryRoot = path.join(dir, 'memory')
    writeFile(path.join(memoryRoot, '日记.md'), '### 日记\n\n' + longBody)
    writeFile(path.join(memoryRoot, '开场.md'), '### 开场\n\n' + longBody)

    const audit = auditSources([
      ...realSource(dialogue),
      {
        id: 'memoryRoot',
        label: '记忆档案目录',
        path: memoryRoot,
        required: false,
        searchable: true,
        format: 'markdown',
        include: ['日记.md', '生长/状态.md', '生长/生长记录.md'],
      },
    ])
    assert.equal(audit.rows[0].status, 'present')
    assert.equal(audit.rows[0].entries, 1)
    // 开场.md 不在 include 里，不能计入
    assert.equal(audit.rows[1].entries, 1)
    assert.equal(audit.searchableEntryCount, 2)
    assert.deepEqual(gateRealInputs(audit.rows, audit), [])

    const missing = auditSources(realSource(path.join(dir, '不存在.md')))
    assert.equal(missing.rows[0].status, 'missing')
    const missingErrors = gateRealInputs(missing.rows, missing)
    assert.ok(missingErrors.some((e) => e.includes('必需输入源不可用')))
    assert.ok(missingErrors.some((e) => e.includes('没有任何可检索条目')))

    const emptyPath = path.join(dir, '空.md')
    writeFile(emptyPath, '   \n\n')
    const empty = auditSources(realSource(emptyPath))
    assert.equal(empty.rows[0].status, 'empty')
    assert.ok(gateRealInputs(empty.rows, empty).some((e) => e.includes('必需输入源不可用')))

    const shortPath = path.join(dir, '太短.md')
    writeFile(shortPath, '### 短\n\n不到四十个字符')
    const short = auditSources(realSource(shortPath))
    assert.equal(short.rows[0].status, 'empty')
    assert.equal(short.searchableEntryCount, 0)

    const dirAsDialogue = path.join(dir, '指向目录')
    fs.mkdirSync(dirAsDialogue, { recursive: true })
    const invalid = auditSources(realSource(dirAsDialogue))
    assert.equal(invalid.rows[0].status, 'invalid')
    assert.ok(gateRealInputs(invalid.rows, invalid).some((e) => e.includes('输入源类型不符')))
  })

  test('可选源缺失不会误伤 real 门禁', () => {
    const dir = tempDir('bench-optional-')
    const dialogue = path.join(dir, '对话记录.md')
    writeFile(dialogue, '### 一条足够长的真实记录\n\n' + '这条记录用于确认可选源缺失时不会拦住基准。'.repeat(3))
    const audit = auditSources([
      ...realSource(dialogue),
      {
        id: 'memoryRoot',
        label: '记忆档案目录',
        path: path.join(dir, '不存在的记忆目录'),
        required: false,
        searchable: true,
        format: 'markdown',
        include: ['日记.md'],
      },
    ])
    assert.equal(audit.rows[1].status, 'missing')
    assert.deepEqual(gateRealInputs(audit.rows, audit), [])
  })

  test('合成语料由 seed 固定，且包含全部探针', () => {
    const rootA = tempDir('bench-syn-a-')
    const rootB = tempDir('bench-syn-b-')
    const rootC = tempDir('bench-syn-c-')
    const a = buildSyntheticCorpus({ rootDir: rootA, seed: 99 })
    const b = buildSyntheticCorpus({ rootDir: rootB, seed: 99 })
    const c = buildSyntheticCorpus({ rootDir: rootC, seed: 100 })

    assert.equal(a.dialogueText, b.dialogueText)
    assert.equal(a.dialogueDigest, b.dialogueDigest)
    assert.equal(a.entryTexts.length, 40)
    assert.equal(a.rows[0].entries, 40)
    assert.equal(a.rows[0].status, 'present')
    for (const probe of DEFAULT_PROBES) {
      assert.ok(a.dialogueText.includes(probe.q), '合成语料缺查询: ' + probe.q)
      assert.ok(a.dialogueText.includes(probe.expectedKeyword))
    }
    assert.notEqual(a.dialogueDigest, c.dialogueDigest)

    const digestA = workloadDigest({ mode: 'synthetic', seed: 99, probes: DEFAULT_PROBES, rows: a.rows })
    const digestB = workloadDigest({ mode: 'synthetic', seed: 99, probes: DEFAULT_PROBES, rows: b.rows })
    const digestC = workloadDigest({ mode: 'synthetic', seed: 100, probes: DEFAULT_PROBES, rows: c.rows })
    assert.equal(digestA, digestB)
    assert.notEqual(digestA, digestC)
  })

  test('缺少 --mode 时退出码 2 并给用法', () => {
    const r = runCli([])
    assert.equal(r.code, EXIT.USAGE)
    assert.ok(r.out.includes('必须显式指定 --mode'))
    assert.ok(r.out.includes('用法:'))
  })

  test('非法 --mode 时退出码 2', () => {
    const r = runCli(['--mode=auto'])
    assert.equal(r.code, EXIT.USAGE)
    assert.ok(r.out.includes('--mode 只能是 real 或 synthetic'))
  })

  test('real 模式必需源缺失时退出码 3，且绝不改用合成语料', () => {
    const dir = tempDir('bench-cli-missing-')
    const r = runCli(['--mode=real'], {
      DSH_MEMORY_ROOT: path.join(dir, 'memory'),
      DSH_MEMORY_DIALOGUE: path.join(dir, '不存在.md'),
      DSH_HOME: path.join(dir, 'home'),
    })
    assert.equal(r.code, EXIT.INPUT_GATE)
    assert.ok(r.out.includes('输入源门禁失败'))
    assert.ok(r.out.includes('必需输入源不可用'))
    assert.ok(!r.out.includes('这不是生产语料成绩'))
    assert.ok(!r.out.includes('[PRESENT] 合成对话语料'))
  })

  test('real 模式真实小语料通过，报告不出现合成警告', () => {
    const dir = tempDir('bench-cli-real-')
    const dialogue = path.join(dir, '对话记录.md')
    writeFile(
      dialogue,
      [
        '## 2026-01-01',
        '',
        '### 本地部署优化方案定稿',
        '',
        '本地部署优化方案已经确定，本地部署优化方案包含完整步骤；优化方案需要覆盖备份、回滚与验证标准。',
        '',
        '### 炉石盒子崩溃排障记录',
        '',
        '炉石盒子崩溃排障记录：炉石盒子更新后崩溃，排障时先清理缓存再回滚插件版本，确认炉石恢复正常。',
        '',
        '### 逆向工程模拟靶场说明',
        '',
        '逆向工程模拟靶场只用于授权测试，逆向工程模拟靶场包含隔离网络、快照恢复与流量镜像，靶场每天重置。',
        '',
        '### 自动刷B站插件配置',
        '',
        '自动刷B站插件只在你本人授权的账号上运行，自动刷B站插件会读取字幕并筛选内容，B站接口有频率限制。',
        '',
        '### 自研记忆核心召回设计',
        '',
        '自研记忆核心使用 BM25-lite 与中文 2-gram，自研记忆核心的召回结果带来源标记，记忆条目支持时间衰减。',
      ].join('\n'),
    )
    const env = {
      DSH_MEMORY_ROOT: path.join(dir, 'memory'),
      DSH_MEMORY_DIALOGUE: dialogue,
      DSH_HOME: path.join(dir, 'home'),
    }
    const r = runCli(['--mode=real'], env)
    assert.equal(r.code, EXIT.OK, r.out)
    assert.ok(r.out.includes('真实工作区延迟基准报告'))
    assert.ok(r.out.includes('生产语料模式'))
    assert.ok(!r.out.includes('这不是生产语料成绩'))
    assert.ok(r.out.includes('[PRESENT] 对话记录文件 (dialogueFile) [REQUIRED]'))
    assert.ok(r.out.includes('P50 '))
    assert.ok(r.out.includes('P95 '))
    assert.ok(r.out.includes('P99 '))
    assert.ok(r.out.includes('结果: PASS'))
  })

  test('real 模式质量门禁失败时退出码 4', () => {
    const dir = tempDir('bench-cli-quality-')
    const dialogue = path.join(dir, '对话记录.md')
    writeFile(
      dialogue,
      '### 烘焙记录\n\n周末做了面包和蛋糕，配方需要面粉、黄油和糖，烤箱温度一百八十度，成品很松软。\n',
    )
    const r = runCli(['--mode=real'], {
      DSH_MEMORY_ROOT: path.join(dir, 'memory'),
      DSH_MEMORY_DIALOGUE: dialogue,
      DSH_HOME: path.join(dir, 'home'),
    })
    assert.equal(r.code, EXIT.PERF_GATE)
    assert.ok(r.out.includes('质量门禁失败'))
  })

  test('synthetic 同 seed 两次：标题警告、指纹与查询顺序一致', () => {
    const dir = tempDir('bench-cli-syn-')
    const env = {
      DSH_MEMORY_ROOT: path.join(dir, 'memory'),
      DSH_MEMORY_DIALOGUE: path.join(dir, '不存在.md'),
      DSH_HOME: path.join(dir, 'home'),
    }
    const first = runCli(['--mode=synthetic', '--seed=1234'], env)
    const second = runCli(['--mode=synthetic', '--seed=1234'], env)
    assert.equal(first.code, EXIT.OK, first.out)
    assert.equal(second.code, EXIT.OK, second.out)

    for (const result of [first, second]) {
      assert.ok(result.out.includes('这不是生产语料成绩'))
      assert.ok(result.out.includes('合成语料延迟基准报告'))
      assert.ok(result.out.includes('模式: synthetic'))
      assert.ok(result.out.includes('[PRESENT] 合成对话语料'))
      assert.ok(!result.out.includes('[PRESENT] 对话记录文件 (dialogueFile)'))
      assert.ok(result.out.includes('P50 '))
      assert.ok(result.out.includes('P95 '))
      assert.ok(result.out.includes('P99 '))
    }
    assert.equal(
      lineWith(first.out, '可复现指纹:'),
      lineWith(second.out, '可复现指纹:'),
    )
    assert.equal(lineWith(first.out, '查询顺序:'), lineWith(second.out, '查询顺序:'))
  })

  test('样本轮数常量与报告口径一致', () => {
    assert.equal(COLD_ROUNDS, 50)
    assert.equal(HOT_ROUNDS, 200)
    assert.ok(DEFAULT_PROBES.length >= 5)
  })

  console.log('benchmark tests passed (' + passed + ' tests)')
} finally {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}