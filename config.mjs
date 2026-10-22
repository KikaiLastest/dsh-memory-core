/**
 * 设置面板可调的参数表 —— 默认值、范围、中文标签都只在这里写一份。
 *
 * 宿主（index.js）用它做读配置时的归一化 + 保存时的校验；
 * 客户端面板（client.js）不重复定义，它从 GET /dsh-memory-core/config 拿这张表来渲染，
 * 免得两边对不上（改一个地方，另一个地方跟着变）。
 *
 * 注意：这里只放「用户该调的」。logFile / autocaptureStore / stateFile / minScore 这些
 * 内部路径与细节仍然只在 cordis.patch.yml 里手动改，不摆在面板上。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 默认档案根的挑选顺序：环境变量 → 本机真实存在的 D 盘工作区 → 跨平台的 ~/dsh-workspace。
// 以前这里写死 D:\dsh-workspace，Linux / macOS 上拿到的是一个永远不存在的路径，
// 然后静默返回空档案，用户只会看到「记忆没有了」却没有任何报错。
function pickExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 探测失败就试下一个 */
    }
  }
  return candidates[candidates.length - 1]
}

const WORKSPACE_FALLBACK = path.join(os.homedir(), 'dsh-workspace')
export const DEFAULT_MEMORY_ROOT = pickExisting([
  process.env.DSH_MEMORY_ROOT,
  'D:\\dsh-workspace\\memory',
  path.join(WORKSPACE_FALLBACK, 'memory'),
])
export const DEFAULT_DIALOGUE_FILE = pickExisting([
  process.env.DSH_MEMORY_DIALOGUE,
  'D:\\dsh-workspace\\对话记录.md',
  path.join(WORKSPACE_FALLBACK, '对话记录.md'),
])

/** 参数分组（面板按这个分节渲染）。 */
export const GROUPS = [
  { id: 'paths', label: '档案来源', hint: '记忆从哪几个文件读；只读，这两个路径不会被写入。' },
  { id: 'recall', label: '召回', hint: '每次注入几条、超时多久、命中门槛多高、权重衰减多快。' },
  { id: 'capture', label: '自动捕获与常驻段', hint: '自动从对话里挑选值得记的句子，以及每轮固定的记忆使用协议。' },
  {
    id: 'summary',
    label: '记忆导航与后台总结',
    hint: '常驻导航告诉模型档案里有什么；后台在对话空闲后把新增小节摘成一行（纯本地规则，不调模型）。',
  },
]

/**
 * 每个字段：key / type / default / label / hint / group，
 * 数字另有 min / max / step / unit / integer。
 */
export const FIELD_DEFS = [
  {
    key: 'memoryRoot',
    type: 'string',
    default: DEFAULT_MEMORY_ROOT,
    label: '档案根目录',
    hint: '日记、生长状态、生长记录都在这个目录下面。',
    group: 'paths',
  },
  {
    key: 'dialogueFile',
    type: 'string',
    default: DEFAULT_DIALOGUE_FILE,
    label: '对话记录文件',
    hint: '召回时当普通语料读的 Markdown 文件。',
    group: 'paths',
  },
  {
    key: 'topK',
    type: 'number',
    default: 3,
    min: 1,
    max: 10,
    step: 1,
    integer: true,
    label: '每次注入条数',
    hint: '一轮最多塞几条召回进去。',
    group: 'recall',
  },
  {
    key: 'timeoutMs',
    type: 'number',
    default: 150,
    min: 50,
    max: 1000,
    step: 10,
    integer: true,
    unit: '毫秒',
    label: '召回超时',
    hint: '超过这个时间还没算完就这轮不注入，不拖慢回复。',
    group: 'recall',
  },
  {
    key: 'minCoverage',
    type: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.05,
    label: '2-gram 覆盖率下限',
    hint: '查询里的二字片段至少命中这个比例才算相关。调高更严、更少。',
    group: 'recall',
  },
  {
    key: 'minMatched',
    type: 'number',
    default: 2,
    min: 1,
    max: 5,
    step: 1,
    integer: true,
    label: '最少命中数',
    hint: '至少命中几个二字片段，防单个高频词误召回。',
    group: 'recall',
  },
  {
    key: 'halfLifeDays',
    type: 'number',
    default: 30,
    min: 1,
    max: 365,
    step: 1,
    integer: true,
    unit: '天',
    label: '权重半衰期',
    hint: '旧记忆的权重每过这么多天减半；越小越偏爱新内容。',
    group: 'recall',
  },
  {
    key: 'dailyQuota',
    type: 'number',
    default: 10,
    min: 0,
    max: 100,
    step: 1,
    integer: true,
    unit: '条/天',
    label: '自动捕获每日配额',
    hint: '每天最多自动记几条；填 0 等于关掉写入但保留召回。',
    group: 'capture',
  },
  {
    key: 'enableStable',
    type: 'boolean',
    default: true,
    label: '注入常驻规则段',
    hint: '每轮都在系统提示里放「记忆使用协议」（记忆是参考、不盲目采信）。',
    group: 'capture',
  },
  {
    key: 'enableAutoCapture',
    type: 'boolean',
    default: true,
    label: '开启自动捕获',
    hint: '从用户消息里挑出值得长期记的句子，写进独立存档。',
    group: 'capture',
  },
  {
    key: 'enableMemoryNav',
    type: 'boolean',
    default: true,
    label: '常驻记忆导航',
    hint: '每轮在系统提示里放一小段「档案有哪些主题、最近几条记忆」，让模型知道该去查什么；没有任何记忆时不注入。',
    group: 'summary',
  },
  {
    key: 'summaryMaxChars',
    type: 'number',
    default: 600,
    min: 80,
    max: 2000,
    step: 20,
    integer: true,
    unit: '字',
    label: '导航长度上限',
    hint: '常驻导航最多这么长，超出的部分按新鲜度从旧到新截断。',
    group: 'summary',
  },
  {
    key: 'enableSummary',
    type: 'boolean',
    default: true,
    label: '后台自动总结',
    hint: '对话记录空闲一段时间后，把新增小节抽成「标题 + 首句」摘要，写到独立 JSONL。',
    group: 'summary',
  },
  {
    key: 'summarizeIntervalMinutes',
    type: 'number',
    default: 10,
    min: 1,
    max: 1440,
    step: 1,
    integer: true,
    unit: '分钟',
    label: '总结检查间隔',
    hint: '每隔多久检查一次对话文件是否已经空闲。',
    group: 'summary',
  },
  {
    key: 'summarizeIdleMinutes',
    type: 'number',
    default: 30,
    min: 1,
    max: 1440,
    step: 1,
    integer: true,
    unit: '分钟',
    label: '对话空闲阈值',
    hint: '对话文件超过这么久没更新才算空闲，避免打断正在进行的会话。',
    group: 'summary',
  },
  {
    key: 'enableSanitize',
    type: 'boolean',
    default: true,
    label: '写入脱敏',
    hint: '写自动捕获和摘要之前，把 sk- / gh*_ / AKIA / Bearer / token= 这类值替换成 [REDACTED]。',
    group: 'summary',
  },
]

/** 只有 key → 默认值 的扁平表。 */
export const DEFAULTS = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f.default]))

/** 数字字段按 step 该保留几位（0.05 这类要留小数，整数不要）。 */
function precisionOf(field) {
  const step = Number(field.step)
  if (!Number.isFinite(step) || step <= 0) return 0
  if (field.integer || step >= 1) return 0
  return Math.min(6, String(step).split('.')[1]?.length || 0)
}

function roundTo(value, digits) {
  if (digits <= 0) return Math.round(value)
  const k = 10 ** digits
  return Math.round(value * k) / k
}

/** 宽松读取：非法值一律退回默认值并夹进范围（启动时用，永不让坏配置炸掉插件）。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const f of FIELD_DEFS) {
    const value = src[f.key]
    if (f.type === 'boolean') {
      if (typeof value === 'boolean') {
        out[f.key] = value
      } else if (typeof value === 'string') {
        const lower = value.trim().toLowerCase()
        if (lower === 'true' || lower === '1') out[f.key] = true
        else if (lower === 'false' || lower === '0') out[f.key] = false
        else out[f.key] = f.default
      } else if (typeof value === 'number') {
        out[f.key] = value !== 0
      } else {
        out[f.key] = f.default
      }
      continue
    }
    if (f.type === 'string') {
      const text = typeof value === 'string' ? value.trim() : ''
      out[f.key] = text === '' ? f.default : text
      continue
    }
    const n = Number(value)
    if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
      out[f.key] = f.default
      continue
    }
    const clamped = Math.min(Number(f.max), Math.max(Number(f.min), n))
    out[f.key] = roundTo(clamped, precisionOf(f))
  }
  return out
}

/**
 * 严格校验（保存时用，不对就报错，不偷偷改用户填的值）。
 * 返回 { ok, values, errors }；errors 是 key → 中文原因。
 */
export function validatePatch(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const values = {}
  const errors = {}
  if (Object.keys(body).length === 0) {
    errors._ = '没有收到要改的参数'
    return { ok: false, values, errors }
  }
  for (const f of FIELD_DEFS) {
    if (!(f.key in body)) continue
    const value = body[f.key]

    if (f.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors[f.key] = `${f.label}只能是开或关`
        continue
      }
      values[f.key] = value
      continue
    }

    if (f.type === 'string') {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') {
        errors[f.key] = `${f.label}不能留空`
        continue
      }
      values[f.key] = text
      continue
    }

    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
    if (String(value ?? '').trim() === '' || !Number.isFinite(n)) {
      errors[f.key] = `${f.label}要填数字`
      continue
    }
    if (n < f.min || n > f.max) {
      errors[f.key] = `${f.label}要在 ${f.min}–${f.max} 之间`
      continue
    }
    values[f.key] = roundTo(n, precisionOf(f))
  }
  return { ok: Object.keys(errors).length === 0, values, errors }
}

/** 给客户端渲染用的纯数据描述（不含函数；数字字段才带 min/max/step）。 */
export function fieldDescriptors() {
  return FIELD_DEFS.map((f) => {
    const base = { key: f.key, type: f.type, label: f.label, hint: f.hint, group: f.group, default: f.default }
    if (f.type !== 'number') return base
    return {
      ...base,
      min: f.min,
      max: f.max,
      step: f.step,
      integer: Boolean(f.integer),
      unit: f.unit || '',
    }
  })
}

export function groupDescriptors() {
  return GROUPS.map((g) => ({ ...g }))
}
