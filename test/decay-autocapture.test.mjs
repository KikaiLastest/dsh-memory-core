import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { computeDecayedWeight, applyScoreDecay, DEFAULT_HALF_LIFE_DAYS } from '../decay.mjs'
import { isWorthCapturing, checkDailyQuota, autoCapture, readCaptureStore } from '../autocapture.mjs'

const TEST_DIR = path.resolve('./.test-tmp')
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
} catch {}
fs.mkdirSync(TEST_DIR, { recursive: true })

console.log('--- 1. 测试 decay.mjs ---')
{
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const halfLifeDays = 30

  // 1.1 刚刚创建（0 天）：权重保持 1.0
  const entry0 = {
    text: '刚刚记住的内容',
    weight: 1.0,
    created_at: new Date(now).toISOString(),
  }
  const w0 = computeDecayedWeight(entry0, now, halfLifeDays)
  assert.ok(Math.abs(w0 - 1.0) < 1e-6, '0天衰减应几乎为1')

  // 1.2 经过 30 天：权重应衰减至 0.5
  const entry30 = {
    text: '30天前的内容',
    weight: 1.0,
    created_at: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
  }
  const w30 = computeDecayedWeight(entry30, now, halfLifeDays)
  assert.ok(Math.abs(w30 - 0.5) < 1e-4, `30天衰减应为0.5，实测: ${w30}`)

  // 1.3 经过 60 天：权重应衰减至 0.25
  const entry60 = {
    text: '60天前的内容',
    weight: 1.0,
    created_at: new Date(now - 60 * 24 * 3600 * 1000).toISOString(),
  }
  const w60 = computeDecayedWeight(entry60, now, halfLifeDays)
  assert.ok(Math.abs(w60 - 0.25) < 1e-4, `60天衰减应为0.25，实测: ${w60}`)

  // 1.4 永久标记：即使经过 300 天，也不衰减
  const entryPerm = {
    text: '永久记忆：我是主人家养的鲸鱼娘',
    weight: 0.9,
    permanent: true,
    created_at: new Date(now - 300 * 24 * 3600 * 1000).toISOString(),
  }
  const wPerm = computeDecayedWeight(entryPerm, now, halfLifeDays)
  assert.equal(wPerm, 0.9, '永久记忆不随时间衰减')

  // 1.5 参与打分乘积计算
  const scoreResult = applyScoreDecay(10.0, entry30, now, halfLifeDays)
  assert.ok(Math.abs(scoreResult.finalScore - 5.0) < 1e-3, '得分应结合衰减权重')
  assert.ok(scoreResult.finalScore > 0, '条目得分降低但不删除')

  console.log('decay tests passed')
}

console.log('--- 2. 测试 autocapture.mjs ---')
{
  const storePath = path.join(TEST_DIR, 'captured.jsonl')
  const now = Date.parse('2026-10-20T12:00:00.000Z')

  // 2.1 规则筛选测试
  assert.equal(isWorthCapturing('你好呀').worth, false, '寒暄不捕获')
  assert.equal(isWorthCapturing('666').worth, false, '简单口癖不捕获')
  assert.equal(isWorthCapturing('以后千万不要把密钥推上公共仓库，这是必须遵守的约定').worth, true, '规则与约定应捕获')
  assert.equal(isWorthCapturing('项目配置改成端口13145，解决办法是加了个重试').worth, true, '配置/排障应捕获')

  // 2.2 安全禁止写入 memory/ 目录检查
  assert.throws(
    () => {
      autoCapture({
        text: '以后记住配置项',
        storePath: 'D:/dsh-workspace/memory/captures.jsonl',
      })
    },
    /Security violation/i,
    '禁止写入 memory 目录应抛出安全错误'
  )

  // 2.3 写入与配额测试（设配额为 2 条）
  const r1 = autoCapture({
    text: '约定规则：每天早上八点自动同步配置',
    storePath,
    dailyQuota: 2,
    now,
  })
  assert.equal(r1.captured, true, '第1条正常捕获')
  assert.ok(r1.record.created_at, '记录应包含 created_at')
  assert.equal(r1.record.weight, 1.0, '记录应包含默认权重')

  // 重复捕获检查
  const rDup = autoCapture({
    text: '约定规则：每天早上八点自动同步配置',
    storePath,
    dailyQuota: 2,
    now,
  })
  assert.equal(rDup.captured, false, '重复内容拒绝捕获')

  const r2 = autoCapture({
    text: '排障解决办法：把网络代理改成直连即可修复bug',
    storePath,
    dailyQuota: 2,
    now,
  })
  assert.equal(r2.captured, true, '第2条正常捕获')

  // 超出配额测试
  const r3 = autoCapture({
    text: '以后记住我的偏好：不吃香菜只吃鱼',
    storePath,
    dailyQuota: 2,
    now,
  })
  assert.equal(r3.captured, false, '超过每日配额应被拦截')
  assert.equal(r3.reason, 'daily_quota_exceeded')

  const stored = readCaptureStore(storePath)
  assert.equal(stored.length, 2, '文件中保存了 2 条有效记录')

  console.log('autocapture tests passed')
}

// 清理临时文件
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
} catch {}

console.log('ALL NEW MODULE TESTS PASSED')
