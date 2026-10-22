import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 包清单自检：保证 package.json 声明的东西真实存在。
// 这条测试的存在理由很实际 —— 之前 npm test 里引用过不存在的测试文件，
// 而外面完全看不出来（&& 链条会静默少跑几步）。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

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

// 4) npm test 里引用的每个文件都存在
const segments = (pkg.scripts?.test || '').split('&&').map((s) => s.trim())
assert.ok(segments.length >= 5, `npm test 只串了 ${segments.length} 条命令，看起来不完整`)
for (const seg of segments) {
  const m = seg.match(/node\s+(\S+)/)
  if (!m) continue
  assert.ok(fs.existsSync(path.join(root, m[1])), `npm test 引用了不存在的文件：${m[1]}`)
}

// 5) 每个 test/*.mjs 都应该被 npm test 串进去，漏了就等于没测
const declared = new Set(
  segments.map((s) => (s.match(/node\s+(\S+)/) || [])[1]).filter(Boolean).map((p) => p.replace(/\.\//g, '')),
)
const onDisk = fs
  .readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.posix.join('test', f))
const missing = onDisk.filter((f) => !declared.has(f))
assert.deepEqual(missing, [], `这些测试没进 npm test：${missing.join(', ')}`)

// 6) 发布包必须带上入口真正 import 的每一个本地模块。
//    只检查 files 里列的条目存不存在，是查不出来的 —— 反过来的漏洞才致命：
//    syn.mjs 被 index.js 静态导入，但没写进 files，npm 发包时不会带上，
//    用户装完就是 MODULE_NOT_FOUND。本地测试全绿也照样过。
//    所以这里从源码的 import 反推，而不是从清单正推。
const shipped = new Set(pkg.files || [])
const localSpec = /from\s+['"]\.\/([^'"]+)['"]/g
const runtimeFiles = (pkg.files || []).filter((f) => /\.(m?js)$/.test(f))
const phantoms = new Set()
for (const file of runtimeFiles) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) continue
  const src = fs.readFileSync(full, 'utf8')
  for (const m of src.matchAll(localSpec)) {
    const dep = m[1]
    if (!shipped.has(dep)) phantoms.add(`${file} -> ./${dep}`)
  }
}
assert.deepEqual(
  [...phantoms],
  [],
  `这些本地模块被发布包里的文件导入，但不在 files 清单里（装完会找不到）：\n  ${[...phantoms].join('\n  ')}`,
)

/** 极简 tar.gz 解包：只处理普通文件，跳过 pax 扩展头，防路径穿越。 */
function extractTarGz(tarball, destDir) {
  const buf = zlibMod.gunzipSync(fs.readFileSync(tarball))
  const root = path.resolve(destDir)
  let off = 0
  let count = 0
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
    const target = path.resolve(root, name)
    if (target !== root && !target.startsWith(root + path.sep)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    count += 1
  }
  assert.ok(count > 0, 'tarball 解出来是空的')
}

// 7) 真实发布包：npm pack 出 tarball、解开、从解出来的目录 import 入口。
//    第 6 条是静态扫描，能抓「漏文件」；但用户拿到的是 tarball，
//    不是工作区目录。只测工作区等于没测交付物。
const os = await import('node:os')
const zlibMod = await import('node:zlib')
const { execFileSync } = await import('node:child_process')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-'))
try {
  // Windows 上 Node 18.20.2+ 起不允许 execFileSync 直接跑 .cmd（CVE-2024-27980 的修法），
  // 所以这里走 cmd.exe /c；Linux/macOS 直接用 npm。
  const packArgs = ['pack', '--json', '--pack-destination', tmp]
  const out =
    process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/c', 'npm', ...packArgs], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : execFileSync('npm', packArgs, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
  const info = JSON.parse(out)[0]
  const tarball = path.join(tmp, info.filename)
  assert.ok(fs.existsSync(tarball), 'npm pack 没有生成 tarball')

  const extractDir = path.join(tmp, 'extract')
  fs.mkdirSync(extractDir)
  // 不调系统 tar：Windows 上是 bsdtar，它对 Temp 的 8.3 短路径（比如 ADMINI~1）
  // 直接报 status 2，而开发时 bash 里那个 tar 是 MSYS 的完全另一套东西，
  // 结果就是「我这儿能过、CI 上过不了」。用 zlib 自己解，三个平台行为一模一样。
  extractTarGz(tarball, extractDir)
  const pkgDir = path.join(extractDir, 'package')
  assert.ok(fs.existsSync(pkgDir), 'tarball 里没有 package/ 目录')

  // tarball 里必须真的带着清单声明的每一个运行时文件
  for (const file of runtimeFiles) {
    assert.ok(fs.existsSync(path.join(pkgDir, file)), `tarball 里缺 ${file}`)
  }

  // 从解出来的目录加载一次，这是用户安装后的真实路径
  const installed = await import(pathToFileURL(path.join(pkgDir, pkg.main)).href)
  assert.equal(typeof installed.apply, 'function', '安装产物里的入口没导出 apply')
  assert.equal(typeof installed.recall, 'function', '安装产物里的入口没导出 recall')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(
  `pack tests passed (${(pkg.files || []).length} files, ${onDisk.length} test files, ${runtimeFiles.length} runtime imports checked, tarball install verified)`,
)
