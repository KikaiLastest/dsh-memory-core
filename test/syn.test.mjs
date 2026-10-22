import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, GENERIC, MAX_EXPANSION, expandWords } from '../syn.mjs'

/**
 * 词表扩展的守卫测试。
 *
 * 这里测的不是「加词之后能召回多少」（那是 scripts/quality-frozen.mjs 的事），
 * 而是「加词之后有没有把查询带到不相关的条目上」——上一轮 496 行词表就是
 * 后一项没测，才让开发集从 100% 掉到 88.9%。
 *
 * 反例优先：先写「哪些查询不许被扩展」，再谈召回。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const corpus = fs.readFileSync(path.join(here, 'fixtures', 'frozen-corpus.md'), 'utf8')

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')
const grams = (s) => {
  const t = norm(s)
  const out = []
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2))
  return [...new Set(out)]
}
/** 取语料里某一小节的正文（含标题行，和 index.js 的切条入口径一致）。 */
const section = (title) => {
  const m = corpus.split(/\n(?=#{2,3} )/).find((p) => norm(p).includes(norm(title)))
  assert.ok(m, '语料里找不到小节: ' + title)
  return m
}

let passed = 0
const test = (name, fn) => {
  fn()
  passed += 1
  console.log('  ok -', name)
}

// ---------- 1. 表结构 ----------

test('每条规则都有 id/kind/weight/pivots/words，且 id 唯一', () => {
  const seen = new Set()
  for (const g of GROUPS) {
    assert.equal(typeof g.id, 'string')
    assert.ok(g.id.length > 0, '缺少 id')
    assert.ok(!seen.has(g.id), '重复 id: ' + g.id)
    seen.add(g.id)
    assert.ok(['synonym', 'related'].includes(g.kind), g.id + ' 的 kind 非法')
    assert.ok(typeof g.weight === 'number' && g.weight > 0 && g.weight < 1, g.id + ' 的 weight 越界')
    assert.ok(Array.isArray(g.pivots) && g.pivots.length > 0, g.id + ' 缺少 pivots')
    assert.ok(Array.isArray(g.words) && g.words.length > 0, g.id + ' 缺少 words')
  }
  assert.ok(GROUPS.length > 0)
})

test('等价组的权重必须高于相关组（层级才有意义）', () => {
  const syn = Math.max(...GROUPS.filter((g) => g.kind === 'synonym').map((g) => g.weight))
  const rel = Math.max(...GROUPS.filter((g) => g.kind === 'related').map((g) => g.weight))
  assert.ok(syn > rel, '等价组 ' + syn + ' 必须高于相关组 ' + rel)
})

// ---------- 2. 泛词黑名单 ----------

test('泛词永远不当触发词', () => {
  for (const g of GROUPS) {
    for (const p of g.pivots) {
      assert.ok(!GENERIC.has(norm(p)), g.id + ' 把泛词「' + p + '」当成了触发词')
    }
  }
})

test('泛词永远不作为扩展词吐出', () => {
  for (const g of GROUPS) {
    for (const w of g.words) {
      assert.ok(!GENERIC.has(norm(w)), g.id + ' 吐出了泛词「' + w + '」')
    }
  }
})

test('「环境」「迁移」「系统」「配置」一个都吐不出来', () => {
  // 这四个是上一轮把 top1 顶错、导致回滚的直接原因
  const banned = ['环境', '迁移', '系统', '配置']
  for (const q of ['服务跑在什么环境上', '部署在哪', '系统怎么配置', '迁移脚本放哪', '环境变量在哪配']) {
    const { words } = expandWords(q)
    for (const w of banned) {
      assert.ok(!words.includes(w), q + ' 吐出了泛词「' + w + '」')
    }
  }
})

// ---------- 3. 反例：不相关的查询不许被扩展 ----------

test('无答案查询不触发任何扩展（冻结集 24 条逐条验）', () => {
  const dir = path.join(here, 'fixtures')
  const files = fs.readdirSync(dir).filter((f) => /^frozen-.*\.json$/.test(f))
  let checked = 0
  for (const f of files) {
    for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      if (c.expect !== null) continue
      checked += 1
      const { words } = expandWords(c.q)
      assert.deepEqual(words, [], '无答案查询被扩展了: ' + c.q + ' -> ' + words.join(','))
    }
  }
  assert.ok(checked >= 20, '无答案样本数量异常，只读到 ' + checked)
})

test('反例：柯基掉毛严重吗（无答案）不许被「品种」类规则拉到狗的条目', () => {
  // 这条查询和「狗的品种」正文共享 2-gram「柯基」，只要把「柯基」设成触发词就会误召。
  assert.deepEqual(expandWords('柯基掉毛严重吗').words, [])
})

test('反例：怎么给猫剪指甲（无答案）不许被单字「猫」触发', () => {
  assert.deepEqual(expandWords('怎么给猫剪指甲').words, [])
})

test('反例：前端缓存查询不许被音乐/视频的扩展词污染', () => {
  // 实测事故：「后端返回的数据怎么设缓存才不白跑请求」曾被「保留最近两百首」拉到音乐条目
  const frontend = section('缓存策略')
  const fg = new Set(grams(frontend))
  const { words } = expandWords('后端返回的数据怎么设缓存才不白跑请求')
  for (const w of words) {
    const hit = grams(w).filter((g) => fg.has(g))
    assert.deepEqual(hit, [], '前端缓存查询被「' + w + '」拉到音乐/视频条目，重合 gram: ' + hit.join(','))
  }
})

test('反例：音乐与视频的扩展词不许互相串台（2-gram 下「播放器」是共享后缀）', () => {
  const music = section('音乐播放器缓存')
  const video = section('视频播放器缓存')
  const mg = new Set(grams(music))
  const vg = new Set(grams(video))
  const pick = (id) => GROUPS.find((g) => g.id === id).words
  for (const w of pick('cache-music')) {
    assert.deepEqual(grams(w).filter((g) => vg.has(g)), [], '音乐组吐出「' + w + '」会命中视频条目')
  }
  for (const w of pick('cache-video')) {
    assert.deepEqual(grams(w).filter((g) => mg.has(g)), [], '视频组吐出「' + w + '」会命中音乐条目')
  }
})

// ---------- 4. 层级优先 ----------

test('同时命中等价组和相关组时，只走等价组（相关组整组丢弃）', () => {
  const { words, weight, tier } = expandWords('端口挂在哪，跑在什么环境')
  assert.equal(tier, 'synonym')
  assert.equal(weight, 0.8)
  // related-host 独有的词「部署」不许被带进来
  assert.ok(!words.includes('部署'), '相关组的词混进了等价组的结果: ' + words.join(','))
})

test('只命中相关组时才使用低权重', () => {
  const { tier, weight } = expandWords('那杯提神的还能喝吗')
  assert.equal(tier, 'related')
  assert.equal(weight, 0.3)
})

// ---------- 5. 其它不变量 ----------

test('查询里已经有的词不重复吐出', () => {
  const { words } = expandWords('花生过敏')
  assert.ok(!words.includes('花生'))
  assert.ok(!words.includes('过敏'))
})

test('扩展词数量有上限', () => {
  const everything = GROUPS.flatMap((g) => g.pivots).join('，')
  const { words } = expandWords(everything)
  assert.ok(words.length <= MAX_EXPANSION, '吐出 ' + words.length + ' 个词，超过上限')
})

test('空输入与纯空白不炸', () => {
  for (const q of ['', '   ', null, undefined]) {
    assert.deepEqual(expandWords(q).words, [])
  }
})

test('同样输入结果稳定，且不修改词表', () => {
  const a = expandWords('平时敲代码主要用什么工具')
  const b = expandWords('平时敲代码主要用什么工具')
  assert.deepEqual(a, b)
  assert.equal(GROUPS.find((g) => g.id === 'editor').words.length, 4)
})

console.log('\nsyn.test: ' + passed + ' 项通过')
