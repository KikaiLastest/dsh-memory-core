import assert from 'node:assert'
import { apply } from '../index.js'
import { DEFAULTS, FIELD_DEFS } from '../config.mjs'

/**
 * 设置面板那两条路由的宿主侧行为：
 *   GET  /dsh-memory-core/config        → 生效值 + 参数表
 *   POST /dsh-memory-core/config/save   → 校验 → 就地生效 → configEditor.edit 落盘
 * 这里用假的 ctx / webServer / configEditor 把 close 掉的那一半跑起来，
 * 不碰 memory/、不碰真 profile。
 */

function makeCtx({ withEditor = true } = {}) {
  const routes = new Map()
  const edits = []
  const sections = []
  const editor = withEditor
    ? {
        entries: () => [{ options: { name: 'dsh-memory-core', config: { topK: 3 } } }],
        edit: async (entry, change) => {
          edits.push({ name: entry.options.name, next: change({ topK: 3, timeoutMs: 150 }, {}) })
        },
      }
    : undefined

  const ctx = {
    inject: (deps, fn) => {
      const child = {
        systemPrompt: {
          section: (section) => {
            sections.push(section.name)
            return () => {
              const at = sections.indexOf(section.name)
              if (at >= 0) sections.splice(at, 1)
            }
          },
          getSectionOrder: () => 0,
        },
        get: (key) => (key === 'configEditor' ? editor : undefined),
        webServer: {
          register: (route) => {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
      }
      fn(child)
    },
    on: () => {},
    effect: (fn) => fn(),
  }
  return { ctx, routes, edits, sections }
}

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
  return res
}

function makeReq(body) {
  return {
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

async function call(route, body) {
  const res = makeRes()
  await route.handler(makeReq(body), res)
  return res
}

// ---- 1. 有 configEditor：读 → 写 → 再读 ----
const one = makeCtx()
apply(one.ctx, {
  memoryRoot: 'D:/tmp/memory',
  dialogueFile: 'D:/tmp/dialogue.md',
  stateFile: 'D:/tmp/state.json',
  logFile: 'D:/tmp/recall.log',
})

assert.ok(one.routes.has('/dsh-memory-core/config'), 'GET 路由挂上了')
assert.ok(one.routes.has('/dsh-memory-core/config/save'), 'POST 路由挂上了')

const got = await call(one.routes.get('/dsh-memory-core/config'))
assert.equal(got.status, 200)
assert.equal(got.body.ok, true)
assert.equal(got.body.editable, true, '有 editor 时面板可持久化')
assert.equal(got.body.fields.length, FIELD_DEFS.length, '把整张参数表给出去了')
assert.equal(got.body.groups.length > 0, true)
for (const f of FIELD_DEFS) assert.ok(f.key in got.body.config, '快照里有 ' + f.key)
assert.equal(got.body.config.topK, DEFAULTS.topK, '没配过就是默认值')
assert.equal(got.body.config.memoryRoot, 'D:/tmp/memory', '配置里的路径生效')

// 越界：拒绝 + 点名 + 一个字都不写
const badSave = await call(one.routes.get('/dsh-memory-core/config/save'), { topK: 11, dailyQuota: -1 })
assert.equal(badSave.body.ok, false)
assert.match(badSave.body.errors.topK, /1–10/)
assert.ok(badSave.body.errors.dailyQuota)
assert.equal(one.edits.length, 0, '校验不过不碰配置文件')

// 合法：落盘 + 当次立刻生效
const goodSave = await call(one.routes.get('/dsh-memory-core/config/save'), {
  topK: 5,
  minCoverage: 0,
  enableAutoCapture: false,
  halfLifeDays: 90,
})
assert.equal(goodSave.body.ok, true, '合法改动保存成功')
assert.equal(goodSave.body.persisted, true)
assert.equal(one.edits.length, 1, '调用了一次 configEditor.edit')
assert.equal(one.edits[0].name, 'dsh-memory-core', '改的是自己那一行')
assert.equal(one.edits[0].next.topK, 5, '新值写进 patch')
assert.equal(one.edits[0].next.enableAutoCapture, false, '布尔写进 patch')
assert.equal(one.edits[0].next.timeoutMs, 150, '没改的字段原样保留')

const after = await call(one.routes.get('/dsh-memory-core/config'))
assert.equal(after.body.config.topK, 5, '不用重启，读到的就是新值')
assert.equal(after.body.config.minCoverage, 0, '0 保留（不会被 || 吃掉）')
assert.equal(after.body.config.enableAutoCapture, false)
assert.equal(after.body.config.halfLifeDays, 90)

// 常驻段开关：不重载插件也要当场挂上 / 摘下
assert.deepEqual(
  [...one.sections].sort(),
  ['dsh-memory-core:affect', 'dsh-memory-core:nav', 'dsh-memory-core:stable'],
  '默认挂了常驻段 + 导航 + affect',
)
const offSave = await call(one.routes.get('/dsh-memory-core/config/save'), { enableStable: false })
assert.equal(offSave.body.ok, true)
assert.deepEqual(
  [...one.sections].sort(),
  ['dsh-memory-core:affect', 'dsh-memory-core:nav'],
  '关掉常驻段：只摘 stable，导航还在',
)
const onSave = await call(one.routes.get('/dsh-memory-core/config/save'), { enableStable: true })
assert.equal(onSave.body.ok, true)
assert.ok(one.sections.includes('dsh-memory-core:stable'), '再打开：又挂回去了')

// 坏 JSON：说人话，不抛
const badJsonRes = makeRes()
await one.routes.get('/dsh-memory-core/config/save').handler(
  {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{ 这不是 json')
    },
  },
  badJsonRes,
)
assert.equal(badJsonRes.body.ok, false)
assert.ok(badJsonRes.body.errors._)
console.log('routes -> read/save/reject ok')

// ---- 2. 没有 configEditor：当场生效但明确说存不进去 ----
const two = makeCtx({ withEditor: false })
apply(two.ctx, { memoryRoot: 'D:/tmp/memory', dialogueFile: 'D:/tmp/dialogue.md' })
const noEditorGet = await call(two.routes.get('/dsh-memory-core/config'))
assert.equal(noEditorGet.body.editable, false)
const noEditorSave = await call(two.routes.get('/dsh-memory-core/config/save'), { topK: 7 })
assert.equal(noEditorSave.body.ok, false)
assert.equal(noEditorSave.body.persisted, false)
assert.match(noEditorSave.body.message, /configEditor/)
const noEditorAfter = await call(two.routes.get('/dsh-memory-core/config'))
assert.equal(noEditorAfter.body.config.topK, 7, '当场生效还是有的')
console.log('routes -> degrade without configEditor ok')

// ---- 3. 没有 webServer（headless）：apply 不炸，也没有面板路由 ----
const three = {
  inject: (deps, fn) => fn({ systemPrompt: { section: () => {}, getSectionOrder: () => 0 } }),
  on: () => {},
  effect: (fn) => fn(),
}
apply(three, { memoryRoot: 'D:/tmp/memory', dialogueFile: 'D:/tmp/dialogue.md' })
console.log('routes -> headless context ok')

console.log('PANEL ROUTES PASSED')
