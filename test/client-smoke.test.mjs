import assert from 'node:assert'
import fs from 'node:fs'
import vm from 'node:vm'

/**
 * 客户端半边（client.js）的冒烟测试。
 *
 * client.js 是浏览器模块：一段挂到 window.__ModuleLoader__ 上的脚本，
 * 没有 import / export，靠 factory(require) 拿 React。
 * 这里用 vm 造一个假 window + 假 React，验证：
 *   1. 模块 id 对（= 包名，客户端模块靠它对上）；
 *   2. factory 能跑通，返回 { inject, apply }；
 *   3. apply 往 `settings.section` 注册，id / label / order 是约定的那几个；
 *   4. 组件在「还没读到数据」这一态能渲染出来，不抛。
 */

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registered = null
const window = {
  __ModuleLoader__: {
    load(mod) {
      registered = mod
    },
  },
}

// 只实现这份面板用到的那几个 API
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const requireStub = (name) => {
  assert.equal(name, 'react', '只 require react（别再引别的客户端包）')
  return React
}

vm.runInNewContext(code, { window, require: requireStub, console, fetch: () => Promise.reject(new Error('no network')) })

assert.ok(registered, '模块挂上了 window.__ModuleLoader__')
assert.equal(registered.id, 'dsh-memory-core', '模块 id = 包名')
assert.equal(typeof registered.factory, 'function')

const mod = registered.factory(requireStub)
assert.equal(typeof mod.apply, 'function', '导出 apply')
assert.deepEqual(mod.inject, ['slots'], '声明注入 slots')

const registered_slots = []
const ctx = {
  get: (key) => (key === 'slots' ? { inject: (owner, fn) => { registered_slots.push({ owner, run: fn }) }, register: (options, component) => ({ options, component }) } : undefined),
}
mod.apply(ctx)

assert.equal(registered_slots.length, 1, '注册了一次')
assert.equal(registered_slots[0].owner, 'settings.section', '进的是设置页的 settings.section')
const declaration = registered_slots[0].run()
assert.equal(declaration.options.name, 'settings.section')
assert.equal(declaration.options.id, 'memory-core')
assert.equal(declaration.options.label, '记忆核心', '左侧导航那一项的名字')
assert.equal(typeof declaration.options.order, 'number')
assert.equal(typeof declaration.component, 'function', '组件是个函数组件')

// 还没读到数据这一态：渲染出标题 + 「读取中…」，不抛
const tree = declaration.component()
const text = []
const walk = (node) => {
  if (node == null || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach(walk)
    return
  }
  if (typeof node === 'object' && typeof node.type === 'string') {
    ;(node.children || []).forEach(walk)
  }
}
walk(tree)
const joined = text.join(' ')
assert.match(joined, /记忆核心/, '面板标题渲染出来')
assert.match(joined, /读取中/, '未取到数据的提示渲染出来')
console.log('client -> module id/registration/render ok')

// 没有 slots（宿主没给）时 apply 不抛
mod.apply({ get: () => undefined })
mod.apply({})
console.log('client -> apply without slots ok')

console.log('CLIENT SMOKE PASSED')
