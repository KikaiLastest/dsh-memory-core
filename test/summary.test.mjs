import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { buildNav, clearSummaryCache, extractDialogueSections, summarizeDialogue } from '../summary.mjs'

const TMP = path.resolve('./.test-summary')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const memoryRoot = path.join(TMP, 'memory')
fs.mkdirSync(path.join(memoryRoot, '生长'), { recursive: true })
fs.writeFileSync(
  path.join(memoryRoot, '日记.md'),
  '# 日记\n\n## 2026-10-20\n\n### #1 ｜ 2026-10-20 ｜ 01:30 ｜ 【PC】 ｜ full\n\n给本地记忆插件加常驻导航和后台摘要，写完跑测试。\n\n### 写入脱敏\n\n自动捕获和摘要写盘前都要过滤常见密钥。\n',
  'utf8',
)
fs.writeFileSync(
  path.join(memoryRoot, '生长', '状态.md'),
  '# 状态\n\n## 【PC】 2026-10-21 01:30 · 进度\n\n导航和摘要都做完了，本地测试全绿。\n',
  'utf8',
)

const dialogueFile = path.join(TMP, '对话记录.md')
fs.writeFileSync(
  dialogueFile,
  '# 对话记录\n\n## 2026-10-22\n\n### 后台总结\n\n检查对话文件 mtime，空闲三十分钟后抽取新增小节。\n\n### 写入脱敏\n\n自动捕获和摘要写入前都调用 sanitize。\n',
  'utf8',
)

const captureStore = path.join(TMP, 'captures.jsonl')
fs.writeFileSync(
  captureStore,
  JSON.stringify({
    id: 'cap-1',
    type: 'auto_capture',
    text: '以后记住配置：token=sk-abcdefghijklmnop123456 别外传。',
    created_at: '2026-10-22T01:00:00.000Z',
    source: 'dialogue',
  }) +
    '\n' +
    JSON.stringify({
      id: 'cap-2',
      type: 'auto_capture',
      text: '## 任务\n\n' + '长任务标记'.repeat(60),
      created_at: '2026-10-22T02:00:00.000Z',
      source: 'dialogue',
    }) +
    '\n',
  'utf8',
)

console.log('--- 1. 空档案不注入 ---')
clearSummaryCache()
assert.equal(buildNav({ memoryRoot: path.join(TMP, 'none') }), '', '没有任何记忆时返回空串')
console.log('empty -> ""')

console.log('--- 1b. 摘要存档禁止写 memory/ ---')
const forbidden = summarizeDialogue(
  { dialogueFile, summaryStore: path.join(memoryRoot, 'summaries.jsonl') },
  { now: Date.now() },
)
assert.equal(forbidden.ok, false)
assert.equal(forbidden.reason, 'forbidden_memory_store', '不许碰 memory/')
console.log('forbidden store -> rejected')

console.log('--- 2. 导航内容 / 来源 / 关键词 / 新鲜度 ---')
clearSummaryCache()
const config = {
  memoryRoot,
  dialogueFile,
  autocaptureStore: captureStore,
  summaryMaxChars: 600,
  enableSanitize: true,
}
const nav = buildNav(config)
assert.ok(nav.length > 0, '有记忆时有导航')
assert.ok(nav.length <= 600, '导航不超过长度上限')
assert.match(nav, /\[记忆导航\]/, '有导航标题')
assert.match(nav, /最近记忆：/, '有最近记忆段')
assert.match(nav, /关键词|（/, '有关键词')
assert.match(nav, /日记：|状态：|对话：|捕获：/, '标了来源')
assert.match(nav, /记忆插件|进度|后台总结|写入脱敏/, '列了主题或摘要')
assert.equal(nav.includes('sk-abcdefghijklmnop123456'), false, '导航里的密钥被脱敏')
assert.ok(nav.includes('[REDACTED]'), '导航里能看到脱敏标记')
assert.equal(nav.includes('长任务标记'), false, '旧的超长任务提示不进导航')
assert.equal(nav.includes('【PC】'), false, '标题里的设备元信息被清洗')
assert.equal(nav.includes('01:30'), false, '标题里的时间位不进导航')
console.log('nav ->', nav.length, 'chars')
console.log(nav.split('\n').slice(0, 4).join('\n'))

console.log('--- 3. 超长按新鲜度截断 ---')
const longDiary = Array.from(
  { length: 60 },
  (_, i) => `### 主题${i}\n\n第${i}条很长的记忆内容，用来把导航预算撑爆。`,
).join('\n\n')
fs.writeFileSync(path.join(memoryRoot, '日记.md'), '# 日记\n\n' + longDiary, 'utf8')
clearSummaryCache()
const small = buildNav({ ...config, summaryMaxChars: 200 })
assert.ok(small.length <= 200, '200 字硬上限，实测 ' + small.length)
assert.match(small, /\[记忆导航\]/, '截断后仍保留导航头')
console.log('truncated ->', small.length, 'chars')

console.log('--- 4. 后台总结：抽取 / 落盘 / 水位幂等 ---')
const summaryStore = path.join(TMP, 'autocapture', 'summaries.jsonl')
const watermarkFile = summaryStore + '.watermark.json'
const idleDialogue = path.join(TMP, 'idle.md')
fs.writeFileSync(
  idleDialogue,
  '# 对话记录\n\n## 2026-10-22\n\n### 后台总结\n\n检查对话文件 mtime，空闲三十分钟后抽取新增小节。\n\n### 写入脱敏\n\n自动捕获和摘要写入前都调用 sanitize。\n',
  'utf8',
)
const old = new Date(Date.now() - 60 * 60 * 1000)
fs.utimesSync(idleDialogue, old, old)

const summaryCfg = {
  dialogueFile: idleDialogue,
  summaryStore,
  summarizeIdleMinutes: 30,
  enableSanitize: true,
}
const first = summarizeDialogue(summaryCfg, { now: Date.now() })
assert.equal(first.ok, true, '空闲文件能总结')
assert.equal(first.added, 2, '抽取两个新增小节')
let records = fs
  .readFileSync(summaryStore, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
assert.equal(records.length, 2)
assert.ok(records.every((r) => r.title && r.summary && r.created_at && r.source_id), '字段齐全')
assert.ok(records.some((r) => r.title === '后台总结'), '标题抽取正确')
assert.ok(fs.existsSync(watermarkFile), '写了水位文件')
console.log('summaries ->', records.map((r) => r.title).join(', '))

const second = summarizeDialogue(summaryCfg, { now: Date.now() + 1000 })
assert.equal(second.reason, 'unchanged', '同样内容不重复总结')
assert.equal(second.added, 0)
assert.equal(fs.readFileSync(summaryStore, 'utf8').trim().split('\n').length, 2, '文件没变长')

console.log('--- 5. 追加新增小节：只总结新的 ---')
fs.appendFileSync(idleDialogue, '\n### 新条目\n\n这是一条新追加的记忆，应该只被总结一次。\n', 'utf8')
fs.utimesSync(idleDialogue, old, old)
const third = summarizeDialogue(summaryCfg, { now: Date.now() + 2000 })
assert.equal(third.ok, true)
assert.equal(third.added, 1, '只抽新增的那一条')
records = fs
  .readFileSync(summaryStore, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
assert.equal(records.length, 3)
assert.equal(records.some((r) => r.title === '新条目'), true)
const fourth = summarizeDialogue(summaryCfg, { now: Date.now() + 3000 })
assert.equal(fourth.reason, 'unchanged', '完成后水位同步')
console.log('incremental -> 2 -> 3, idempotent')

console.log('--- 6. 没空闲就不总结 ---')
fs.writeFileSync(idleDialogue, fs.readFileSync(idleDialogue, 'utf8') + '\n### 刚写的\n\n这一节刚写入，还没到空闲阈值。\n', 'utf8')
const notIdle = summarizeDialogue(summaryCfg, { now: Date.now() })
assert.equal(notIdle.ok, false)
assert.equal(notIdle.reason, 'not_idle')
console.log('not idle -> skipped')

console.log('--- 7. 摘要写入前脱敏 ---')
const secretDialogue = path.join(TMP, 'secret.md')
const secretStore = path.join(TMP, 'autocapture', 'secret-summaries.jsonl')
fs.writeFileSync(
  secretDialogue,
  '# 对话记录\n\n## 2026-10-22\n\n### 配置\n\n以后把钥匙记好：token=sk-abcdefghijklmnop123456 别丢。\n',
  'utf8',
)
fs.utimesSync(secretDialogue, old, old)
const secretResult = summarizeDialogue(
  { dialogueFile: secretDialogue, summaryStore: secretStore, summarizeIdleMinutes: 30, enableSanitize: true },
  { now: Date.now() },
)
assert.equal(secretResult.added, 1)
const secretRaw = fs.readFileSync(secretStore, 'utf8')
assert.equal(secretRaw.includes('sk-abcdefghijklmnop123456'), false, '摘要文件里不能有明文密钥')
assert.ok(secretRaw.includes('[REDACTED]'))
console.log('summary sanitize -> ok')

console.log('--- 8. 开关关闭时保留原文 ---')
const rawStore = path.join(TMP, 'autocapture', 'raw-summaries.jsonl')
const rawResult = summarizeDialogue(
  { dialogueFile: secretDialogue, summaryStore: rawStore, summarizeIdleMinutes: 30, enableSanitize: false },
  { now: Date.now() + 10_000 },
)
assert.equal(rawResult.added, 1)
assert.ok(fs.readFileSync(rawStore, 'utf8').includes('sk-abcdefghijklmnop123456'), '关掉脱敏就按原文写')
console.log('sanitize toggle -> ok')

console.log('--- 9. extractDialogueSections 跳过容器标题 ---')
const sections = extractDialogueSections('## 2026-10-22\n\n### 标题一\n\n这是第一节的内容，足够长。\n')
assert.equal(sections.length, 1, '日期容器本身不算条目')
assert.equal(sections[0].title, '标题一')
assert.ok(sections[0].key && sections[0].key.length === 16)
console.log('extract ->', sections.length, 'section')

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {}

console.log('SUMMARY PASSED')
