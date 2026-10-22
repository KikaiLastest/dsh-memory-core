import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

// 包清单自检：保证 package.json 声明的东西真实存在。
// 这条测试的存在理由很实际 —— 之前 npm test 里引用过不存在的测试文件，
// 而外面完全看不出来（&& 链条会静默少跑几步）。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// 0) package.json 里不许有重复键。
//    JSON.parse 遇到重复键会静默取最后一个 —— 合并冲突留下的两条 "test"
//    看起来一切正常，实际上只有一条在跑。这一轮 master 合并就留下了两份，
//    所以把它变成会红的检查，而不是靠人眼。
function findDuplicateKeys(text) {
  const duplicates = []
  const stack = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      let raw = ''
      while (j < text.length) {
        const code = text.charCodeAt(j)
        // 92 = 反斜杠：连着下一个字符一起进 raw，避免把 \" 当成字符串结尾
        if (code === 92) {
          raw += text[j] + text[j + 1]
          j += 2
          continue
        }
        if (code === 34) break
        raw += text[j]
        j += 1
      }
      const key = JSON.parse('"' + raw + '"')
      const frame = stack[stack.length - 1]
      if (frame && frame.type === 'obj') {
        let k = j + 1
        while (k < text.length && /\s/.test(text[k])) k += 1
        if (frame.expectingKey && text[k] === ':') {
          if (frame.keys.has(key)) duplicates.push(key)
          frame.keys.add(key)
          frame.expectingKey = false
        } else if (!frame.expectingKey) {
          frame.expectingKey = true
        }
      }
      i = j + 1
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push({ type: ch === '{' ? 'obj' : 'arr', keys: new Set(), expectingKey: ch === '{' })
      i += 1
      continue
    }
    if (ch === '}' || ch === ']') {
      stack.pop()
      const frame = stack[stack.length - 1]
      if (frame && frame.type === 'obj') frame.expectingKey = true
      i += 1
      continue
    }
    if (ch === ',') {
      const frame = stack[stack.length - 1]
      if (frame && frame.type === 'obj') frame.expectingKey = true
      i += 1
      continue
    }
    i += 1
  }
  return duplicates
}

// 扫描器自己先验一遍，免得它永远返回空数组、看起来永远绿
const synthetic = '{"a":1,"b":{"c":2,"c":3},"a":2}'
assert.deepEqual(findDuplicateKeys(synthetic).sort(), ['a', 'c'], '重复键扫描器自身失效')
const rawPkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
assert.deepEqual(
  findDuplicateKeys(rawPkg),
  [],
  'package.json 里有重复键（JSON.parse 会静默取最后一个，等于有一条配置被悄悄丢掉）',
)

// 1) files 清单里每一条都得在
for (const entry of pkg.files || []) {
  assert.ok(fs.existsSync(path.join(root, entry)), `files 清单里的 "${entry}" 不存在`)
}

// 2) exports 指向的目标都得能加载（.yml / .json 只查存在）
for (const [key, target] of Object.entries(pkg.exports || {})) {
  const rel = typeof target === 'string' ? target : target?.import || target?.default
  assert.ok(rel, `exports["${key}"] 没有可用的目标`)
  assert.ok(fs.existsSync(path.join(root, rel)), `exports["${key}"] 指向的 ${rel} 不存在`)
}

// 3) main 入口真的能被 import
assert.ok(pkg.main, 'main 字段缺失')
const mod = await import(pathToFileURL(path.join(root, pkg.main)).href)
assert.equal(typeof mod.apply, 'function', 'main 入口必须导出 apply')

// 4) 每条 npm script 里 node 的入口文件都得存在。
//    只查 test 那一条会漏掉 benchmark / quality / consolidate 这些，
//    它们同样是「敲了就炸」的类型，只是没那么常跑。
const allScripts = pkg.scripts || {}
for (const [name, script] of Object.entries(allScripts)) {
  for (const m of String(script).matchAll(/node\s+(\S+)/g)) {
    const file = m[1]
    assert.ok(fs.existsSync(path.join(root, file)), `scripts.${name} 引用了不存在的文件：${file}`)
  }
}

// 5) 每个 test/**/*.test.mjs 都必须被某条 npm script 串起来，漏了就等于没测。
//    这里扫递归目录：兼容测试放在 test/compat/ 下也算，不能靠「不在根目录」逃过检查。
//    同时不限定必须挂在 "test" 那条上 —— 兼容测试走独立的 test:compat，
//    集成负责人决定要不要并进主链，但「有没有人跑它」必须可查。
function walkTestFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTestFiles(abs))
    else if (entry.name.endsWith('.test.mjs')) out.push(path.relative(root, abs).split(path.sep).join('/'))
  }
  return out
}
const onDisk = walkTestFiles(path.join(root, 'test'))
assert.ok(onDisk.length >= 5, `只找到 ${onDisk.length} 个测试文件，看起来不完整`)
const declared = new Set()
for (const script of Object.values(allScripts)) {
  for (const m of String(script).matchAll(/node\s+(\S+)/g)) declared.add(m[1].replace(/^\.\//, ''))
}
const missing = onDisk.filter((f) => !declared.has(f))
assert.deepEqual(missing, [], `这些测试没进任何 npm script：${missing.join(', ')}`)

// 6) 发布包必须带上入口真正 import 的每一个本地模块。
//    只检查 files 里列的条目存不存在，是查不出来的 —— 反过来的漏洞才致命：
//    syn.mjs 被 index.js 静态导入，但没写进 files，npm 发包时不会带上，
//    用户装完就是 MODULE_NOT_FOUND。本地测试全绿也照样过。
//    所以这里从源码的 import 反推，而不是从清单正推。
const shipped = new Set(pkg.files || [])
// 静态 import 和动态 import('./x') 都要扫：动态那条一旦漏了，
// 本地全绿、用户那边运行时才 MODULE_NOT_FOUND。
const localSpec = /from\s+['"]\.\/([^'"]+)['"]/g
const dynamicSpec = /import\s*\(\s*['"]\.\/([^'"]+)['"]/g
const runtimeFiles = (pkg.files || []).filter((f) => /\.(m?js)$/.test(f))
const phantoms = new Set()
for (const file of runtimeFiles) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) continue
  const src = fs.readFileSync(full, 'utf8')
  for (const spec of [localSpec, dynamicSpec]) {
    for (const m of src.matchAll(spec)) {
      const dep = m[1]
      if (!shipped.has(dep)) phantoms.add(`${file} -> ./${dep}`)
    }
  }
}
assert.deepEqual(
  [...phantoms],
  [],
  `这些本地模块被发布包里的文件导入，但不在 files 清单里（装完会找不到）：\n  ${[...phantoms].join('\n  ')}`,
)

/** 极简 tar.gz 解包：只处理普通文件，跳过 pax 扩展头，防路径穿越。返回解出来的文件名。 */
function extractTarGz(tarball, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(tarball))
  const dest = path.resolve(destDir)
  let off = 0
  const names = []
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size =
      parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(header[156])
    const dataStart = off + 512
    const body = buf.subarray(dataStart, dataStart + size)
    off = dataStart + Math.ceil(size / 512) * 512
    // x/g/L/K 是 pax 扩展头和长文件名块，本身不是文件
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') continue
    if (!name || name.endsWith('/')) continue
    const target = path.resolve(dest, name)
    if (target !== dest && !target.startsWith(dest + path.sep)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    names.push(name.split('\\').join('/'))
  }
  assert.ok(names.length > 0, 'tarball 解出来是空的')
  return names
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-'))
const npmRun = (args, cwd) =>
  execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/c', 'npm', ...args] : args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  )

try {
  // 7) 真实发布包：npm pack 出 tarball、解开、从解出来的目录 import 入口。
  //    第 6 条是静态扫描，能抓「漏文件」；但用户拿到的是 tarball，
  //    不是工作区目录。只测工作区等于没测交付物。
  const info = JSON.parse(npmRun(['pack', '--json', '--pack-destination', tmp], root))[0]
  const tarball = path.join(tmp, info.filename)
  assert.ok(fs.existsSync(tarball), 'npm pack 没有生成 tarball')

  const extractDir = path.join(tmp, 'extract')
  fs.mkdirSync(extractDir)
  // 不调系统 tar：Windows 上是 bsdtar，它对 Temp 的 8.3 短路径（比如 ADMINI~1）
  // 直接报 status 2，而开发时 bash 里那个 tar 是 MSYS 的完全另一套东西，
  // 结果就是「我这儿能过、CI 上过不了」。用 zlib 自己解，三个平台行为一模一样。
  const tarballFiles = extractTarGz(tarball, extractDir)
  const pkgDir = path.join(extractDir, 'package')
  assert.ok(fs.existsSync(pkgDir), 'tarball 里没有 package/ 目录')

  // 7a) tarball 里必须真的带着清单声明的每一个运行时文件
  for (const file of runtimeFiles) {
    assert.ok(fs.existsSync(path.join(pkgDir, file)), `tarball 里缺 ${file}`)
  }

  // 7b) 反过来，tarball 里不许出现清单之外的文件。
  //     npm 永远带 package.json / README / LICENSE，其余一律要对得上 files 条目。
  //     这一条防的是「多发」：测试语料、内部文档、记忆档案、node_modules 混进包里。
  const relInTarball = tarballFiles
    .map((n) => (n.startsWith('package/') ? n.slice('package/'.length) : n))
    .filter(Boolean)
  const alwaysIncluded = /^(package\.json|README(\.[a-z]+)?|LICEN[CS]E(\.[a-z]+)?)$/i
  const declaredPaths = (pkg.files || []).map((f) => f.replace(/\/+$/, ''))
  const unexpected = relInTarball.filter(
    (f) => !alwaysIncluded.test(f) && !declaredPaths.some((d) => f === d || f.startsWith(d + '/')),
  )
  assert.deepEqual(unexpected, [], `tarball 里有清单之外的文件（不该发出去）：\n  ${unexpected.join('\n  ')}`)
  for (const forbidden of ['memory/', 'node_modules/', '.git/', 'test/']) {
    assert.ok(
      !relInTarball.some((f) => f.startsWith(forbidden)),
      `tarball 里不该出现 ${forbidden}`,
    )
  }

  // 7c) exports / dsh 声明指向的文件必须真的在包里
  const mustShip = new Set([pkg.main])
  for (const target of Object.values(pkg.exports || {})) {
    const rel = typeof target === 'string' ? target : target?.import || target?.default
    if (rel && !rel.endsWith('.json')) mustShip.add(rel)
  }
  if (pkg.dsh?.bundle?.patch) mustShip.add(pkg.dsh.bundle.patch)
  if (pkg.dsh?.client?.entry) mustShip.add(pkg.dsh.client.entry)
  for (const file of mustShip) {
    assert.ok(fs.existsSync(path.join(pkgDir, file)), `tarball 里缺声明过的 ${file}`)
  }

  // 7d) 从解出来的目录加载一次
  const installed = await import(pathToFileURL(path.join(pkgDir, pkg.main)).href)
  assert.equal(typeof installed.apply, 'function', '安装产物里的入口没导出 apply')
  assert.equal(typeof installed.recall, 'function', '安装产物里的入口没导出 recall')
  assert.equal(typeof installed.recallWithVerdict, 'function', '安装产物里的入口没导出 recallWithVerdict')

  // 7e) 真正的安装验证：建一个干净消费者项目，把 tarball 装进去，
  //     然后**按包名**导入。上面那个 import 走的是绝对文件路径，
  //     绕过了 npm 的包解析和 exports 字段——而用户遇到的恰恰是那一层。
  const consumer = path.join(tmp, 'consumer')
  fs.mkdirSync(consumer)
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
  )
  npmRun(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', tarball], consumer)

  // 7f) 子路径 exports 也得能解析（client / cordis.patch.yml / package.json）。
  //     它们是字符串入口，import 会真的去执行浏览器脚本，所以只查解析结果。
  const subpaths = Object.keys(pkg.exports || {}).filter((k) => k !== '.')
  for (const sub of subpaths) {
    const spec = sub === '.' ? pkg.name : pkg.name + '/' + sub.replace(/^\.\//, '')
    const probe = `const { createRequire } = require('node:module'); const r = createRequire(process.cwd() + '/'); process.stdout.write(r.resolve(${JSON.stringify(spec)}))`
    const resolved = execFileSync(process.execPath, ['-e', probe], { cwd: consumer, encoding: 'utf8', timeout: 60000 }).trim()
    assert.ok(resolved && fs.existsSync(resolved), `干净安装后解析不了 exports 子路径 ${spec}`)
  }

  // 7g) 只测「import 成功」是假绿：函数在、但可能一调就崩。
  //     这里在安装产物里真跑一次召回 + 注入（探针是 test/compat/installed-probe.mjs）。
  const dataDir = path.join(consumer, 'data')
  const memoryRoot = path.join(dataDir, 'memory')
  fs.mkdirSync(path.join(memoryRoot, '生长'), { recursive: true })
  fs.writeFileSync(
    path.join(memoryRoot, '日记.md'),
    ['## 2026-10-20', '', '- 阿尔法项目数据库使用 PostgreSQL 16，主键走雪花 ID。', ''].join('\n'),
    'utf8',
  )
  const dialogueFile = path.join(dataDir, '对话记录.md')
  fs.writeFileSync(dialogueFile, '## 2026-10-20\n\n- 阿尔法项目数据库使用 PostgreSQL 16。\n', 'utf8')
  fs.copyFileSync(path.join(root, 'test', 'compat', 'installed-probe.mjs'), path.join(consumer, 'probe.mjs'))
  const dshHome = path.join(tmp, 'dsh-home')
  fs.mkdirSync(dshHome, { recursive: true })
  const probeOut = execFileSync(process.execPath, ['probe.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      PROBE_MODE: 'configured',
      PROBE_MEMORY: memoryRoot,
      PROBE_DIALOGUE: dialogueFile,
      PROBE_DATA: path.join(dataDir, 'store'),
    },
  })
  const resultLine = probeOut.split('\n').find((l) => l.startsWith('RESULT:'))
  assert.ok(resultLine, '安装产物探针没有输出结果行')
  const probeResult = JSON.parse(resultLine.slice('RESULT:'.length))
  assert.equal(probeResult.directRecallError, null, '安装产物里 recall() 抛错：' + probeResult.directRecallError)
  assert.ok(probeResult.hits >= 1, '安装产物里召回一条都没命中（hits=' + probeResult.hits + '）')
  assert.equal(probeResult.contractOk, true, '安装产物返回的命中项不满足公共契约字段')
  assert.ok(probeResult.sections >= 1, '安装产物里常驻段没挂上')
  assert.ok(probeResult.hadDecision, '安装产物里 pre-step 没返回决策')

  console.log(
    `pack tests passed (${(pkg.files || []).length} files, ${onDisk.length} test files, ${runtimeFiles.length} runtime imports checked, ${relInTarball.length} tarball entries verified, install + recall + inject verified)`,
  )
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
