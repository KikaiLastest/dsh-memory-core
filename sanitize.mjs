/**
 * 写入前的轻量脱敏：只认常见的密钥/token 形态，不碰普通中文与代码。
 *
 * 纯本地正则，不联网、不调模型。两个导出：
 * - sanitize(text)     → 把命中的凭证值换成 [REDACTED]
 * - redactCount(text)  → 这段文本里会被替换几处（调用方决定要不要提示）
 *
 * 设计取舍：
 * - 简单 token 先替换（sk- / gh*_ / github_pat_ / AKIA），再处理 Bearer 与 key=value，
 *   这样 `Bearer sk-...` 只会算一次，不会重复计数。
 * - 已经替换成 [REDACTED] 的位置用负向前瞻跳过，所以 sanitize(sanitize(x)) === sanitize(x)。
 * - 只替换“值”不吞掉键名：`password=xxx` → `password=[REDACTED]`，排障时还看得出是哪类配置。
 */

const SIMPLE_RULES = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}(?![\w-])/g, repl: '[REDACTED]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}(?![\w-])/g, repl: '[REDACTED]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}(?![\w-])/g, repl: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}(?!\w)/g, repl: '[REDACTED]' },
  { re: /\b(Bearer)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi, repl: (match, prefix) => prefix + ' [REDACTED]' },
  {
    // password=xxx / token: "xxx" / api_key: 'xxx' —— 保留键名和分隔符，只抹值
    re: /(\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&"')\]}，；：！？。、]+)/gi,
    repl: (match, prefix) => prefix + '[REDACTED]',
  },
]

function applyRules(input) {
  const text = typeof input === 'string' ? input : ''
  let out = text
  let count = 0
  for (const rule of SIMPLE_RULES) {
    out = out.replace(rule.re, (...args) => {
      count += 1
      return typeof rule.repl === 'function' ? rule.repl(...args) : rule.repl
    })
  }
  return { text: out, count }
}

/** 把命中的凭证值替换成 [REDACTED]；非字符串按空串处理。 */
export function sanitize(text) {
  return applyRules(text).text
}

/** 这段文本里会被替换几处（按 sanitize 的同一套规则顺序计算）。 */
export function redactCount(text) {
  return applyRules(text).count
}
