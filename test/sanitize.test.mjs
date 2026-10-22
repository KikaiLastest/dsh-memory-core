import assert from 'node:assert'
import { sanitize, redactCount } from '../sanitize.mjs'

/** 密钥模式覆盖：sk- / gh*_ / github_pat_ / AKIA / Bearer / key=value。 */
const secrets = [
  'sk-abcdefghijklmnop123456',
  'ghp_abcdefghijklmnopqrstuvwxyz012345',
  'gho_abcdefghijklmnopqrstuvwxyz012345',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  'AKIAABCDEFGHIJKLMNOP',
  'Bearer abc.def-123_456',
  'password=hunter2',
  'token: "abc123"',
  "api-key='xyz789'",
]

const text = '配置：' + secrets.join('；') + '。'
const clean = sanitize(text)

console.log('--- 1. 各类密钥都能命中 ---')
for (const secret of secrets) {
  assert.equal(clean.includes(secret), false, '不应残留：' + secret)
}
assert.ok(clean.includes('[REDACTED]'), '命中后替换成 [REDACTED]')
assert.ok(clean.includes('password=[REDACTED]'), '保留键名、只抹 password 的值')
assert.ok(clean.includes('token: [REDACTED]'), '保留 token: 前缀')
assert.ok(clean.includes('api-key=[REDACTED]'), 'api-key 也覆盖')
assert.ok(clean.includes('Bearer [REDACTED]'), 'Bearer 保留前缀')
assert.equal(redactCount(text), secrets.length, '9 处命中各算一次')
console.log('sanitize ->', secrets.length, 'secrets redacted')

console.log('--- 2. 幂等 + 大小写 ---')
assert.equal(sanitize(clean), clean, 'sanitize 幂等')
assert.equal(redactCount(clean), 0, '已脱敏的文本不再计数')
assert.equal(sanitize('Authorization: bearer AbCdEf1234567890'), 'Authorization: bearer [REDACTED]', 'Bearer 不区分大小写')
assert.equal(sanitize('API_KEY: "sk-abcdefghijklmnop123456"'), 'API_KEY: [REDACTED]', '大写 key 也覆盖')

console.log('--- 3. 不误伤普通文本 ---')
const normal = [
  '普通中文里没有密钥，只有记忆、导航和摘要。',
  'passwordless login works fine',
  'sk-learn is a tiny library',
  'token 化处理文本是常见做法',
  '记忆导航的长度上限是 600 字。',
]
for (const sample of normal) {
  assert.equal(sanitize(sample), sample, '不该改：' + sample)
  assert.equal(redactCount(sample), 0, '不该计数：' + sample)
}
console.log('normal text -> untouched')

console.log('--- 4. 空值 / 非字符串 ---')
assert.equal(sanitize(''), '')
assert.equal(sanitize(null), '')
assert.equal(redactCount(undefined), 0)
console.log('edge cases -> ok')

console.log('SANITIZE PASSED')
