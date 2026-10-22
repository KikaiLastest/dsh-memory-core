// 并发 / 交错调用不同配置的召回，缓存不能互相污染。
//
// loadCached 用的是模块级单例 cache，cacheKey 里带了各数据文件的 mtime+size。
// 单线程下 recall 是同步的，理论不会交错；但「理论上不会」不是证据，
// 这条测试用两个内容完全不同、且互相不包含对方关键词的工作区交替调用，
// 断言每次结果都只来自自己的数据源。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { recall, invalidateMemoryCache } from '../index.js'

const mkWorkspace = (token, topic) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-' + token + '-'))
  const memoryRoot = path.join(root, 'memory')
  fs.mkdirSync(path.join(memoryRoot, '记忆'), { recursive: true })
  const dialogueFile = path.join(root, '对话记录.md')
  fs.writeFileSync(
    dialogueFile,
    '## 2026-09-01\n\n### ' + token + ' 配置\n\n' + topic + '\n',
    'utf8',
  )
  return {
    root,
    cfg: {
      memoryRoot,
      dialogueFile,
      structuredFile: path.join(memoryRoot, '记忆', 'structured.jsonl'),
      topK: 3,
      minCoverage: 0.1,
      minMatched: 1,
      minRatio: 0.1,
      halfLifeDays: 3650,
    },
  }
}

const A = mkWorkspace('alpha', 'Alpha 服务监听的端口是 18081，配置在 alpha.yml。')
const B = mkWorkspace('beta', 'Beta 服务监听的端口是 29092，配置在 beta.yml。')

try {
  invalidateMemoryCache()
  const qa = 'Alpha 服务监听端口'
  const qb = 'Beta 服务监听端口'

  // 交替调用：A -> B -> A -> B，模拟两个配置在同一进程里来回切换
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    invalidateMemoryCache()
    const ra = recall(A.cfg, qa, Date.now() + 5000)
    seen.push(['A', ra.map((h) => h.entry.text).join(' ')])
    const rb = recall(B.cfg, qb, Date.now() + 5000)
    seen.push(['B', rb.map((h) => h.entry.text).join(' ')])
  }

  for (const [who, text] of seen) {
    if (who === 'A') {
      assert.ok(!text.includes('Beta'), 'A 的结果里不应出现 B 的数据：' + text.slice(0, 80))
      assert.ok(!text.includes('29092'), 'A 的结果里不应出现 B 的端口')
    } else {
      assert.ok(!text.includes('Alpha'), 'B 的结果里不应出现 A 的数据：' + text.slice(0, 80))
      assert.ok(!text.includes('18081'), 'B 的结果里不应出现 A 的端口')
    }
  }

  // 不 invalidate，直接交错：走缓存命中路径，同样不能串
  const ra2 = recall(A.cfg, qa, Date.now() + 5000)
  const rb2 = recall(B.cfg, qb, Date.now() + 5000)
  const ra3 = recall(A.cfg, qa, Date.now() + 5000)
  const joinA = ra2.concat(ra3).map((h) => h.entry.text).join(' ')
  const joinB = rb2.map((h) => h.entry.text).join(' ')
  assert.ok(!joinA.includes('Beta') && !joinA.includes('29092'), '缓存命中路径下 A 不能拿到 B 的数据')
  assert.ok(!joinB.includes('Alpha') && !joinB.includes('18081'), '缓存命中路径下 B 不能拿到 A 的数据')

  console.log('concurrent config tests passed')
} finally {
  fs.rmSync(A.root, { recursive: true, force: true })
  fs.rmSync(B.root, { recursive: true, force: true })
}
