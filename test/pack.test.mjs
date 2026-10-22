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

console.log(`pack tests passed (${(pkg.files || []).length} files, ${onDisk.length} test files)`)
