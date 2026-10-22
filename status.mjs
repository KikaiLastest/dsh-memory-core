import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * 记忆状态与身份权威语义模块。
 * 召回（index.js）与常驻导航（summary.mjs）必须共用本模块，禁止各自实现状态查找与优先级判定。
 *
 * 身份契约定义：
 *   1. contentId: mem-{sha1(text).slice(0, 12)}
 *      内容哈希是记忆在跨生命周期、跨会话中的唯一稳定身份。
 *   2. sourceRef: "dialogue:{line}" 或 "diary:{line}"
 *      原文物理坐标，仅用于追溯，会随用户编辑产生位置漂移。
 *   3. representationId: 表现形式 ID
 *      - 原文条目: 继承 sourceRef（如 "dialogue:12"）
 *      - 摘要条目: "sum-{id}"
 *      - 捕获条目: "captured-{id}"
 */

/** 一条记忆的稳定内容身份：完整文本的 sha1 前缀。 */
export function idOf(text) {
  return 'mem-' + crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)
}

/**
 * 归一化提取小节标题指纹，用于长文本摘要去重（抗行号漂移）。
 */
export function titleFingerprint(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 归一化标题指纹：第一行去掉 Markdown 井号，压平空白。
 * 状态表里的 fact 就是固化那一刻的小节标题，用来做弱身份匹配。
 */
export function factFingerprint(text) {
  const first =
    String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || ''
  return first.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 正文前缀指纹：跳过标题行，取正文前 48 个非空白字符。
 * 行号会漂、标题可能被改，但正文开头是内容自己的影子，不受物理位置影响。
 */
export function bodyFingerprint(text, len = 48) {
  const s = String(text || '').replace(/\r\n/g, '\n')
  const idx = s.indexOf('\n')
  if (idx < 0) return ''
  return s.slice(idx + 1).replace(/\s+/g, '').slice(0, len)
}

/**
 * 降级保护下的 legacy 哨兵。
 *
 * 只有当状态表 `degraded` 且命中的记录确实没有 status 字段时才返回：
 * 那种记录无法证明自己没被淘汰，按契约「宁可少召回」处理。
 * 它不会出现在 structured.jsonl 里；召回与导航共用 isRecallable，答案因此一致。
 */
export const LEGACY_UNVERIFIED = 'legacy-unverified'

/**
 * 坐标漂移哨兵（严格身份模式）。
 *
 * 内容身份（contentId / 正文哈希）一个都没命中，只有 sourceId 坐标撞上了表里的记录。
 * 行号会随编辑插入而漂移，位置不是身份：坐标撞上的很可能只是另一条小节。
 * 返回该哨兵，让安全方向（不召回）生效；它和 LEGACY_UNVERIFIED 一样不出现在 structured.jsonl 里。
 */
export const UNVERIFIED_DRIFT = 'unverified-drift'

/**
 * 解析任意记忆条目（原文小节、摘要或捕获项）在当前状态表中的权威状态。
 *
 * 优先级顺序严格固定：
 * 1. 显式内容身份 (entry.contentId)
 * 2. 文本内容哈希计算所得身份 (idOf(entry.text))
 * 3. 来源物理坐标 (entry.sourceId || entry.id)
 *
 * 两条保守规则：
 * - 身份冲突取更严的一侧：contentId 指向 active、正文哈希却指向 superseded 时返回 superseded。
 *   否则一条抄着已淘汰正文的条目，只要 content_id 填了有效记录就能洗白。
 * - 降级 + legacy：状态表损坏时，缺 status 字段的记录返回 LEGACY_UNVERIFIED，不再被当成显式 active。
 *   旧版本固化产物（没有 status 字段）在表一坏时整体停用，这是契约里的保守方向。
 *
 * @param {Object} entry 记忆条目
 * @param {Object} statusMap loadStatusMap 返回的状态映射
 * @param {Object} [options]
 * @param {boolean} [options.strictIdentity=false] 严格身份模式：坐标只用于识别漂移，不用于判定状态
 * @returns {string|null} 'active' | 'superseded' | 'archived' | 'draft' | 'legacy-unverified' | 'unverified-drift' | null(未受状态管理)
 */
export function resolveEntryStatus(entry, statusMap, options = {}) {
  if (!entry || !statusMap) return null
  const byContentId = statusMap.byContentId
  const bySourceId = statusMap.bySourceId
  const degraded = Boolean(statusMap.degraded)
  const legacyContentIds = statusMap.legacyContentIds
  const legacySourceIds = statusMap.legacySourceIds

  let active = null
  let legacyHit = false
  let blocked = null

  const consider = (status, isLegacy) => {
    if (status === undefined || status === null) return
    if (status !== 'active') {
      // 多个身份里只要有一个说「不是 active」，就按不可召回处理
      if (blocked === null) blocked = status
      return
    }
    if (isLegacy) legacyHit = true
    if (active === null) active = status
  }

  // 1. 显式内容身份优先（例如摘要中记录的原文 content_id）
  if (entry.contentId && byContentId?.has(entry.contentId)) {
    consider(byContentId.get(entry.contentId), Boolean(legacyContentIds?.has(entry.contentId)))
  }

  // 2. 原文内容完整哈希（原文条目）
  if (entry.text) {
    const cid = idOf(entry.text)
    if (byContentId?.has(cid)) {
      consider(byContentId.get(cid), Boolean(legacyContentIds?.has(cid)))
    }
  }

  if (blocked !== null) return blocked
  if (active !== null) return degraded && legacyHit ? LEGACY_UNVERIFIED : active

  // 3. 弱身份（仅严格模式）：标题 / 正文前缀。
  //    行号会漂、标题可能被改写，但正文开头不会因为「上方插两行」而变化。
  //    只对物理文件派生的条目（原文小节 / 摘要）生效：自动捕获不是状态表索引的
  //    原文，不能因为一句相同的开场白就被套上别人的废弃状态。
  if (options.strictIdentity && entry.text && isWeakEligible(entry)) {
    const bodyHit = statusMap.byBody?.get(bodyFingerprint(entry.text))
    if (bodyHit) consider(bodyHit.status, bodyHit.legacy)
    const factHit = statusMap.byFact?.get(factFingerprint(entry.text))
    if (factHit) consider(factHit.status, factHit.legacy)
    if (blocked !== null) return blocked
    if (active !== null) return degraded && legacyHit ? LEGACY_UNVERIFIED : active
  }

  // 4. 来源位置匹配（辅助兜底：行号命中且未被内容哈希覆盖）
  // 严格身份模式（召回池）：走到这里说明内容身份一个都没命中。
  // 此时坐标只是位置，不是身份——撞上的记录可能属于另一条小节，
  // 「改个标题 + 上方插两行」就能借别人的 active 记录让旧决策还魂。
  // 所以不再信任坐标，统一返回漂移哨兵，由调用方按不可召回处理。
  const src = entry.sourceId || entry.id
  if (src && bySourceId?.has(src)) {
    if (options.strictIdentity) return UNVERIFIED_DRIFT
    consider(bySourceId.get(src), Boolean(legacySourceIds?.has(src)))
    if (blocked !== null) return blocked
    if (active !== null) return degraded && legacyHit ? LEGACY_UNVERIFIED : active
  }

  return null
}

/**
 * 状态有效性判定。
 *
 * @param {string|null} status 状态值
 * @param {Object} [options]
 * @param {boolean} [options.degraded=false] 状态表是否处于损坏或无法读取的降级状态
 * @param {boolean} [options.conservative=true] 降级时是否采取保守防御策略
 * @returns {boolean} 是否允许召回/注入
 */
export function isRecallable(status, options = {}) {
  // 默认保守：状态表损坏时，无法证明有效的记忆一律不召回。
  // 反过来（默认放行）会让被 superseded 的旧决策在状态表一坏时整体复活，
  // 而模型会照着它执行——这比「记不住」危险得多。
  const { degraded = false, conservative = true } = options

  // 降级下无法自证的 legacy 记录跟随同一个 conservative 开关：
  // 默认压掉，显式 conservative=false 才放行（给整表破损时留一个逃生口）。
  if (status === LEGACY_UNVERIFIED) {
    return !conservative
  }

  // 坐标漂移无法自证内容身份：位置证明不了「这条就是当时被治理的那条」，
  // 即使状态表健康也不能放行，否则改标题 + 行号漂移即可复活旧事实。
  if (status === UNVERIFIED_DRIFT) {
    return false
  }

  // 显式废弃/归档/草稿，任何时候坚决不可召回
  if (status && status !== 'active') {
    return false
  }

  // 显式标明 active
  if (status === 'active') {
    return true
  }

  // status 为 null/undefined 表示该记忆未记录在 structured.jsonl 中
  // 在状态表正常或首次运行时，按向后兼容策略放行
  if (!degraded) {
    return true
  }

  // 状态表损坏或不可读（degraded）：
  // 若启用保守策略，未知条目视为不可信，防止被取代的历史旧决策在状态表损坏时整体复活
  return !conservative
}

/**
 * 统一多通道候选过滤管道。
 * 供 index.js 候选池加载与 summary.mjs 常驻导航共用。
 *
 * @param {Array<Object>} entries 候选条目列表
 * @param {Object} statusMap loadStatusMap 返回的状态元数据
 * @param {Object} [options]
 * @param {boolean} [options.conservative=true] 降级时是否保守过滤
 * @returns {{ recallable: Array<Object>, suppressed: number, unverified: number, idDrift: number }}
 */
export function filterRecallableEntries(entries, statusMap, options = {}) {
  const recallable = []
  let suppressed = 0
  let unverified = 0
  let idDrift = 0
  let driftSuppressed = 0

  const degraded = Boolean(statusMap && statusMap.degraded)
  // 和 isRecallable 同一个安全默认：降级时宁可少召回，不可放出过期决策
  const conservative = options.conservative === undefined ? true : Boolean(options.conservative)
  let legacySuppressed = 0

  for (const entry of entries) {
    // 严格身份模式：内容哈希 / contentId 优先，坐标只用于识别漂移，不用于判定状态。
    const status = resolveEntryStatus(entry, statusMap, { strictIdentity: true })

    // 坐标撞上了记录，但内容身份对不上：位置漂移，按不可召回处理。
    if (status === UNVERIFIED_DRIFT) {
      idDrift += 1
      unverified += 1
      driftSuppressed += 1
      continue
    }

    if (!isRecallable(status, { degraded, conservative })) {
      if (status === LEGACY_UNVERIFIED) {
        unverified += 1
        legacySuppressed += 1
      } else if (status && status !== 'active') {
        suppressed += 1
      } else {
        unverified += 1
      }
      continue
    }

    recallable.push(entry)
  }

  return { recallable, suppressed, unverified, idDrift, legacySuppressed, driftSuppressed }
}

/**
 * 严格模式下允许使用弱身份（标题 / 正文前缀）的条目。
 *
 * 只认物理文件派生的条目：
 * - 原文小节：id 形如 `<src>:<line>` 且 line > 0；
 * - 摘要（src === 'summary'）：没有物理行，但标题继承自原文小节。
 * 自动捕获（captured-*，line=0）不是状态表索引的原文，不套用弱身份，
 * 否则用户刚批准的捕获会凭一句相同的开场白继承别人的废弃状态。
 *
 * @param {Object} entry 记忆条目
 * @returns {boolean}
 */
function isWeakEligible(entry) {
  if (!entry) return false
  const line = Number(entry.line)
  if (Number.isInteger(line) && line > 0 && typeof entry.src === 'string' && entry.id === entry.src + ':' + line) {
    return true
  }
  return entry.src === 'summary'
}

export const VALID_STATUSES = new Set(['active', 'superseded', 'archived', 'draft'])

/**
 * 读固化产物的状态表。
 * 建立双向索引并输出明确的健康诊断状态。
 *
 * 状态机完备分类：
 *   - 'missing': 文件未配置或文件不存在（ENOENT），属首次正常初始状态，不降级
 *   - 'empty': 文件存在但内容为零字节或纯空白（截断/损坏），强制 degraded=true 保护
 *   - 'unreadable': 文件存在但由于权限/锁读取失败，强制 degraded=true 保护
 *   - 'corrupt': 存在非空行但全部记录解析或结构损坏，强制 degraded=true 保护
 *   - 'cycle_conflict': 替代关系形成有向环（A 取代 B、B 又取代 A），强制降级
 *   - 'dangling_reference': supersedes 指向文件里不存在的 id，强制降级
 *   - 'partial_corrupt': 包含有效记录，但夹杂语法坏行、非法状态枚举或缺少契约，强制 degraded=true
 *   - 'ok': 状态文件完整，且全部记录通过 schema 契约校验
 *
 * 非致命的诊断（不影响 degraded，只是记账）：
 *   - coordinateConflicts: 同一 source_id 上出现互相矛盾的状态。归并时保守取 'superseded'，
 *     但这是正常生命周期（改过正文再固化会复用同一物理行），不按损坏处理。
 *
 * @param {Object} cfg 配置对象，需包含 structuredFile
 * @returns {{
 *   bySourceId: Map<string, string>,
 *   byContentId: Map<string, string>,
 *   legacyContentIds: Set<string>,
 *   legacySourceIds: Set<string>,
 *   byBody: Map<string, {status: string, legacy: boolean}>,
 *   byFact: Map<string, {status: string, legacy: boolean}>,
 *   degraded: boolean,
 *   reason: 'ok' | 'missing' | 'empty' | 'unreadable' | 'corrupt' | 'cycle_conflict' | 'dangling_reference' | 'partial_corrupt' | 'not_configured',
 *   totalRecords: number,
 *   validRecords: number,
 *   totalLines: number,
 *   syntaxErrors: number,
 *   schemaErrors: number,
 *   coordinateConflicts: number,
 *   danglingRefs: number,
 *   cycleErrors: number,
 *   brokenLines: number
 * }}
 */
/** 统一构造状态表返回结构：四处字面量各写一遍，少一个字段就是一次召回事故。 */
function emptyStatusMap(overrides) {
  return {
    bySourceId: new Map(),
    byContentId: new Map(),
    legacyContentIds: new Set(),
    legacySourceIds: new Set(),
    byBody: new Map(),
    byFact: new Map(),
    degraded: false,
    reason: 'ok',
    totalRecords: 0,
    validRecords: 0,
    totalLines: 0,
    syntaxErrors: 0,
    schemaErrors: 0,
    coordinateConflicts: 0,
    danglingRefs: 0,
    cycleErrors: 0,
    brokenLines: 0,
    ...overrides,
  }
}

export function loadStatusMap(cfg = {}) {
  const file = cfg.structuredFile

  if (!file) {
    return emptyStatusMap({ reason: 'not_configured' })
  }

  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const missing = err && err.code === 'ENOENT'
    return emptyStatusMap({ degraded: !missing, reason: missing ? 'missing' : 'unreadable' })
  }

  // 区分「文件不存在」与「文件存在但被截断为空」：
  // 文件存在却为空说明经历了异常清空或截断，不能按首次运行的兼容策略放行
  if (!text.trim()) {
    return emptyStatusMap({ degraded: true, reason: 'empty' })
  }

  const bySourceId = new Map()
  const byContentId = new Map()
  // 没写 status 字段的记录：正常时按 legacy 放行，降级时不能再冒充显式 active
  const legacyIds = new Set()
  const byMemId = new Map()
  const records = []
  let syntaxErrors = 0
  let schemaErrors = 0
  let totalLines = 0
  let danglingRefs = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    totalLines += 1
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      syntaxErrors += 1
      continue
    }

    // 严格契约校验：
    // 1. 必须是对象且包含合法字符串 id 与 source_id
    // 2. status 状态契约收敛：
    //    - 若缺失或为 null，按向后兼容迁移策略赋以明确的 'active' 确定状态；
    //    - 若为合法枚举字符串，保留其值；
    //    - 若为非法枚举值或非字符串类型，坚决计入 schemaErrors 并触发降级保护。
    // 3. supersedes 字段如果显式存在，必须是非空合法字符串或显式 null，拦截 ""、0、false、数组等假值
    // 4. 拦截自身替代 (supersedes === id)
    // 5. 拦截重复 ID 冲突
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !rec.id.trim() || typeof rec.source_id !== 'string' || !rec.source_id.trim()) {
      schemaErrors += 1
      continue
    }

    let status = 'active'
    let statusExplicit = false
    if (rec.status !== undefined && rec.status !== null) {
      if (typeof rec.status === 'string' && VALID_STATUSES.has(rec.status)) {
        status = rec.status
        statusExplicit = true
      } else {
        // 非法枚举或非法类型（数字、数组等）
        schemaErrors += 1
        continue
      }
    }

    if (Object.hasOwn(rec, 'supersedes')) {
      const s = rec.supersedes
      if (s !== null && s !== undefined) {
        if (typeof s !== 'string' || !s.trim()) {
          schemaErrors += 1 // 拦截 supersedes: ""、0、false、[] 等非法假值
          continue
        }
        if (s === rec.id) {
          schemaErrors += 1 // 自身替代悖论
          continue
        }
      }
    }

    if (byMemId.has(rec.id)) {
      schemaErrors += 1 // 重复 ID 冲突
      continue
    }

    records.push({ rec, status })
    byMemId.set(rec.id, rec)
    byContentId.set(rec.id, status)
    if (!statusExplicit) legacyIds.add(rec.id)
  }

  // ── 来源坐标 source_id 一对多顺序无关确定性归并 ──────────────────────
  // 物理行号会随文件编辑插入而自然漂移。同一 source_id 在不同历史小节中出现时：
  // 采用状态集合归并，彻底消除 Map.set() 依赖文件行遍历顺序的不确定性。
  const sourceStatuses = new Map()
  const sourceAllLegacy = new Map() // 该坐标上的记录是否全部没有 status 字段
  for (const { rec, status } of records) {
    let set = sourceStatuses.get(rec.source_id)
    if (!set) {
      set = new Set()
      sourceStatuses.set(rec.source_id, set)
      sourceAllLegacy.set(rec.source_id, true)
    }
    set.add(status)
    if (!legacyIds.has(rec.id)) sourceAllLegacy.set(rec.source_id, false)
  }
  let coordinateConflicts = 0
  const legacySourceIds = new Set()
  for (const [srcId, set] of sourceStatuses) {
    if (set.size === 1) {
      bySourceId.set(srcId, set.values().next().value)
    } else {
      // 出现状态歧义（同一坐标既有 active 又有 superseded），保守归约为 'superseded'
      // 避免行顺序随机决定状态，强制依赖内容哈希作为权威身份。
      // 不算成致命损坏：改过正文再固化，同一条物理行自然会出现新旧两条记录，这是正常生命周期。
      coordinateConflicts += 1
      bySourceId.set(srcId, 'superseded')
    }
    if (sourceAllLegacy.get(srcId)) legacySourceIds.add(srcId)
  }

  // ── 有向图引用完整性、覆盖传递与迭代式环路检测（Stack-Safe Cycle Detection）──
  const graph = new Map() // id -> supersedes_id
  for (const { rec } of records) {
    if (!rec.supersedes || typeof rec.supersedes !== 'string') continue
    const target = byMemId.get(rec.supersedes)
    if (!target) {
      danglingRefs += 1 // 悬空引用：指向不存在的目标记录
      continue
    }
    graph.set(rec.id, rec.supersedes)
    if (target.source_id) bySourceId.set(target.source_id, 'superseded')
    if (target.id) byContentId.set(target.id, 'superseded')
  }

  // 显式栈迭代 DFS 检测有向环，彻底消除长链递归爆栈（Stack Overflow）风险
  const visitState = new Map() // 0: 未访, 1: 栈中, 2: 完成
  let cycleErrors = 0
  for (const startId of graph.keys()) {
    if (visitState.get(startId) === 2) continue
    const stack = [startId]
    const pathSet = new Set()
    while (stack.length > 0) {
      const curr = stack[stack.length - 1]
      if (!visitState.has(curr)) {
        visitState.set(curr, 1)
        pathSet.add(curr)
        const next = graph.get(curr)
        if (next && graph.has(next)) {
          if (pathSet.has(next)) {
            cycleErrors += 1
            break
          }
          if (visitState.get(next) !== 2) {
            stack.push(next)
            continue
          }
        }
      }
      pathSet.delete(curr)
      visitState.set(curr, 2)
      stack.pop()
    }
  }

  // ── 弱身份索引（仅供严格身份模式使用）──────────────────────────────
  // 物理行号会漂、标题可能被改写，但正文开头 48 个字不会因为「上方插两行」而变化。
  // 只有内容身份完全没命中时才启用，作为坐标之外的独立证据。
  const byBody = new Map()
  const byFact = new Map()
  const addWeak = (map, key, status, legacy) => {
    if (!key) return
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { status, legacy })
      return
    }
    if (prev.status !== status) {
      // 同一个弱指纹对应多条记录：取更严的一侧，不允许 active 洗白 superseded
      prev.status = prev.status === 'active' ? status : prev.status
    }
    prev.legacy = prev.legacy && legacy
  }
  for (const { rec, status } of records) {
    const legacy = legacyIds.has(rec.id)
    addWeak(byBody, bodyFingerprint(rec.quote || ''), status, legacy)
    addWeak(byFact, factFingerprint(rec.fact || rec.quote || ''), status, legacy)
  }

  const badLines = syntaxErrors + schemaErrors + danglingRefs + cycleErrors
  const isCorrupt = records.length === 0 && badLines > 0
  const isPartialCorrupt = records.length > 0 && badLines > 0
  const degraded = isCorrupt || isPartialCorrupt

  let reason = 'ok'
  if (isCorrupt) {
    reason = 'corrupt'
  } else if (cycleErrors > 0) {
    reason = 'cycle_conflict'
  } else if (danglingRefs > 0) {
    reason = 'dangling_reference'
  } else if (isPartialCorrupt) {
    reason = 'partial_corrupt'
  }

  return {
    bySourceId,
    byContentId,
    legacyContentIds: legacyIds,
    legacySourceIds,
    byBody,
    byFact,
    degraded,
    reason,
    // totalRecords 是「解析尝试过的非空行数」，和 validRecords 不是一回事：
    // 两者相等时说明一行都没坏，差多少就是坏了多少。
    totalRecords: totalLines,
    validRecords: records.length,
    totalLines,
    syntaxErrors,
    schemaErrors,
    coordinateConflicts,
    danglingRefs,
    cycleErrors,
    brokenLines: badLines,
  }
}
