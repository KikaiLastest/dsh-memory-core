import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 数据目录与代码目录的隔离测试 —— 用真实的 npm pack / install 来跑。
 *
 * 这条测试的存在理由：插件装在 node_modules 里，用户的记忆档案在别处；
 * 升级 = 删掉整个 node_modules 再装一遍。插件只要往自己包里写一个字节，
 * 或者默认路径算到了安装目录下，那次升级就会把用户数据一起带走。
 *
 * 验证四件事：
 *   1. 默认路径落在 DSH_HOME，不落在安装目录；
 *   2. 跑完召回 / 注入后，安装目录文件逐个哈希不变（一个字节都没写）；
 *   3. 用户的 memory/ 数据跑完不被改动；
 *   4. 删掉 node_modules 重装（模拟升级）后，同一份数据还在、召回结果一致。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const pkgJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-iso-'))

function npm(args, cwd) {
  return execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/c', 'npm', ...args] : args,
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 },
  )
}

/** 目录快照：相对路径 → sha256，用来证明「这里没被写过」。 */
function snapshot(dir) {
  const out = new Map()
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'))
    }
  }
  if (fs.existsSync(dir)) walk(dir, '')
  return out
}

function diffSnapshots(before, after) {
  const changed = []
  for (const [file, hash] of after) {
    if (!before.has(file)) changed.push('+' + file)
    else if (before.get(file) !== hash) changed.push('~' + file)
  }
  for (const file of before.keys()) if (!after.has(file)) changed.push('-' + file)
  return changed
}

let checked = 0
function ok(label, condition, detail = '') {
  assert.ok(condition, detail ? label + ' —— ' + detail : label)
  checked += 1
}

try {
  // ── 打包 + 干净安装 ────────────────────────────────────────────────
  const info = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp], repo))[0]
  const tarball = path.join(tmp, info.filename)
  assert.ok(fs.existsSync(tarball), 'npm pack 没有生成 tarball')

  const consumer = path.join(tmp, 'consumer')
  fs.mkdirSync(consumer)
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
  )
  const installArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', tarball]
  npm(installArgs, consumer)

  const installedDir = path.join(consumer, 'node_modules', pkgJson.name)
  assert.ok(fs.existsSync(installedDir), '安装目录不存在')
  ok('安装目录里没有用户数据目录 memory/', !fs.existsSync(path.join(installedDir, 'memory')))
  ok('安装目录里没有 test/（语料不进发布包）', !fs.existsSync(path.join(installedDir, 'test')))

  // ── 模拟用户档案（全部放在安装目录之外）──────────────────────────
  const dataRoot = path.join(consumer, 'data')
  const memoryRoot = path.join(dataRoot, 'memory')
  fs.mkdirSync(path.join(memoryRoot, '生长'), { recursive: true })
  fs.writeFileSync(
    path.join(memoryRoot, '日记.md'),
    ['## 2026-10-20', '', '- 阿尔法项目数据库使用 PostgreSQL 16，主键走雪花 ID。', ''].join('\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(memoryRoot, '生长', '状态.md'), '- 心情不错\n', 'utf8')
  const dialogueFile = path.join(dataRoot, '对话记录.md')
  fs.writeFileSync(dialogueFile, '## 2026-10-20\n\n- 阿尔法项目数据库使用 PostgreSQL 16。\n', 'utf8')

  const memoryBefore = snapshot(memoryRoot)
  ok('档案基线：目录里有文件', memoryBefore.size >= 2, 'files=' + memoryBefore.size)

  const dshHome = path.join(tmp, 'dsh-home')
  const fakeHome = path.join(tmp, 'fake-home')
  fs.mkdirSync(dshHome, { recursive: true })
  fs.mkdirSync(fakeHome, { recursive: true })

  const probeName = 'probe.mjs'
  fs.copyFileSync(path.join(here, 'installed-probe.mjs'), path.join(consumer, probeName))

  function runProbe(mode, extraEnv = {}) {
    const out = execFileSync(process.execPath, [probeName], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        PROBE_MODE: mode,
        PROBE_MEMORY: memoryRoot,
        PROBE_DIALOGUE: dialogueFile,
        PROBE_DATA: path.join(dataRoot, 'store'),
        ...extraEnv,
      },
    })
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(line, '探针没有输出结果行：' + out.slice(0, 400))
    return JSON.parse(line.slice('RESULT:'.length))
  }

  // ── 1. 按配置走：真召回 + 真注入 ─────────────────────────────────
  const installedBefore = snapshot(installedDir)
  const configured = runProbe('configured')
  ok('安装产物能按包名导入并跑通召回', configured.hits >= 1, 'hits=' + configured.hits)
  ok('命中项满足公共契约字段', configured.contractOk === true)
  ok('pre-step 返回决策对象', configured.hadDecision === true)
  ok('常驻段能挂上', configured.sections >= 1, 'sections=' + configured.sections)
  ok('注入条数不超过 1（每轮最多一条召回消息）', configured.injected <= 1, 'injected=' + configured.injected)

  // ── 2. 安装目录没被写过 ──────────────────────────────────────────
  const installedAfter = snapshot(installedDir)
  const touched = diffSnapshots(installedBefore, installedAfter)
  ok('运行后安装目录一个文件都没变', touched.length === 0, touched.join(', '))

  // ── 3. 用户档案没被写过 ──────────────────────────────────────────
  const memoryAfter = snapshot(memoryRoot)
  ok('运行后用户 memory/ 数据未被改动', diffSnapshots(memoryBefore, memoryAfter).length === 0, diffSnapshots(memoryBefore, memoryAfter).join(', '))

  // ── 4. 默认路径落在 DSH_HOME，不在安装目录 ───────────────────────
  const defaults = runProbe('defaults')
  ok('不给配置也能跑（默认值可用）', defaults.hadDecision === true)
  ok('默认日志写进 DSH_HOME', fs.existsSync(path.join(dshHome, 'recall.log')))
  ok('默认日志没写进安装目录', !fs.existsSync(path.join(installedDir, 'recall.log')))
  ok('fake home 没被碰（默认路径不依赖用户主目录扫描）', snapshot(fakeHome).size === 0, [...snapshot(fakeHome).keys()].join(', '))
  ok('默认模式下安装目录依然没变', diffSnapshots(installedBefore, snapshot(installedDir)).length === 0)

  // ── 5. 模拟升级：删掉整个 node_modules 重装 ─────────────────────
  fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true })
  fs.rmSync(path.join(consumer, 'package-lock.json'), { force: true })
  npm(installArgs, consumer)
  const reinstalledDir = path.join(consumer, 'node_modules', pkgJson.name)
  assert.ok(fs.existsSync(reinstalledDir), '重装后安装目录不存在')

  ok('重装后包内容与升级前一致（同 tarball 幂等）', diffSnapshots(installedBefore, snapshot(reinstalledDir)).length === 0)
  ok('重装后用户档案还在', diffSnapshots(memoryBefore, snapshot(memoryRoot)).length === 0)
  ok('重装后目录结构没多出 memory/', !fs.existsSync(path.join(reinstalledDir, 'memory')))

  const afterUpgrade = runProbe('configured')
  ok('升级后召回仍然可用', afterUpgrade.hits >= 1, 'hits=' + afterUpgrade.hits)
  ok(
    '升级前后命中 ID 一致（同一份数据、同一结果）',
    JSON.stringify(afterUpgrade.ids) === JSON.stringify(configured.ids),
    JSON.stringify(configured.ids) + ' -> ' + JSON.stringify(afterUpgrade.ids),
  )
  ok('升级后用户档案仍未被改动', diffSnapshots(memoryBefore, snapshot(memoryRoot)).length === 0)
  ok('升级后安装目录仍未被写入', diffSnapshots(installedBefore, snapshot(reinstalledDir)).length === 0)

  console.log('数据隔离测试通过（' + checked + ' 项断言，含一次真实升级重装）')
  process.exit(0)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
