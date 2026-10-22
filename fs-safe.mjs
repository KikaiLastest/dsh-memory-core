import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 文件层的错误分类。
 *
 * 以前所有读路径都写成「try 读、catch 就返回默认值」，
 * 于是「文件不存在」「权限拒绝」「JSON 损坏」「磁盘 I/O 失败」混成同一个分支。
 * 对水位文件（watermark）尤其危险：损坏被当成空，等于谎报「这些记录没处理过」。
 * 从现在起这四种语义必须能被调用方分开处理。
 */
export const FS_MISSING = 'missing' // 文件/目录不存在
export const FS_DENIED = 'denied' // 权限拒绝（EACCES / EPERM / EROFS）
export const FS_CORRUPT = 'corrupt' // 内容存在但解析不了（只有读 JSON/JSONL 会产出）
export const FS_IO = 'io' // 其余系统调用失败：EIO / ENOSPC / EMFILE / EISDIR / ELOOP …

const IS_WIN = process.platform === 'win32'
// macOS 默认是大小写不敏感卷，宁可多拒（fail closed）也不能少拒。
const CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin'

const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])
const MISSING_CODES = new Set(['ENOENT'])
// 只有读取类阶段，ENOENT 才等于「这个文件不存在」。
// rename / open / write 阶段的 ENOENT 是「临时文件或目录中途没了」，属于 I/O 故障，
// 报成 missing 会让调用方误以为「目标从来没写过」，从而做出错误的重建决定。
const READ_PHASES = new Set(['read', 'stat', 'list', 'resolve'])
// Windows 上 rename 覆盖目标时，杀毒 / 索引器 / 正在读的句柄会短暂返回这些码。
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'])

/** 原子写入的临时文件名形状：目标名 . pid . 12 位十六进制 . tmp */
export const TEMP_FILE_PATTERN = /\.(\d+)\.[0-9a-f]{12}\.tmp$/

/** 带分类的文件错误。kind 恒为四种语义之一。 */
export class FsSafeError extends Error {
  constructor(kind, code, message, details = {}) {
    super(message)
    this.name = 'FsSafeError'
    this.kind = kind
    this.code = code || String(kind || 'EUNKNOWN').toUpperCase()
    this.filePath = details.filePath || null
    this.phase = details.phase || null
    if (details.cause) this.cause = details.cause
  }

  get missing() {
    return this.kind === FS_MISSING
  }

  /** 只有 missing / corrupt 是可以重建的；denied / io 不能靠覆写修好。 */
  get recoverable() {
    return this.kind === FS_MISSING || this.kind === FS_CORRUPT
  }
}

/**
 * 把任意系统调用抛出的错误归一成 FsSafeError。
 *
 * phase 会影响结论：读取阶段的 ENOENT 是「文件不存在」，rename 阶段的 ENOENT
 * 是「临时文件不见了」，属于 I/O 故障 —— 同一个 errno 在不同阶段含义不同。
 *
 * @param {unknown} error 原始错误
 * @param {{ phase?: string, filePath?: string }} [context]
 * @returns {FsSafeError}
 */
export function classifyFsError(error, context = {}) {
  if (error instanceof FsSafeError) return error
  const phase = context.phase || 'read'
  const filePath = context.filePath || null
  const code = (error && (error.code || error.errno)) || 'EUNKNOWN'
  const message = String((error && error.message) || error || '未知文件系统错误')
  if ((MISSING_CODES.has(code) || code === 'ENOTDIR') && READ_PHASES.has(phase)) {
    return new FsSafeError(FS_MISSING, code, message, { filePath, phase, cause: error })
  }
  if (DENIED_CODES.has(code)) {
    return new FsSafeError(FS_DENIED, code, message, { filePath, phase, cause: error })
  }
  return new FsSafeError(FS_IO, code, message, { filePath, phase, cause: error })
}

function isSameOrInside(child, parent) {
  if (child === parent) return true
  // 父路径本身是根（例如盘符根）时不能再补分隔符，否则永远匹配不上。
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(withSep)
}

function canonicalize(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    /* 目标还不存在：退而求其次，规范化父目录 */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(target)), path.basename(target))
  } catch {
    return target
  }
}

/**
 * 解析「写入最终会落到哪里」，逐层跟随符号链接（含悬空链接与链式链接）。
 *
 * 悬空链接（指向还不存在的文件）是正常的：把链接目标当作创建点，
 * 而不是把链接本身替换掉 —— 后者会静默毁掉用户「把存储软链到另一块盘」的设置。
 * 链接成环（ELOOP）无法证明落点，直接抛错，绝不猜。
 *
 * @param {string} filePath 目标路径
 * @param {{ maxLinkDepth?: number, fs?: object }} [options]
 * @returns {string} 规范化后的真实写入目标
 */
export function resolveWriteTarget(filePath, options = {}) {
  const impl = options.fs || fs
  const maxLinkDepth = Number.isFinite(options.maxLinkDepth) ? options.maxLinkDepth : 32
  const rawText = String(filePath || '')
  if (!rawText) throw new FsSafeError(FS_IO, 'EINVAL', '目标路径不能为空', { phase: 'resolve' })

  let current = path.resolve(rawText)
  for (let depth = 0; depth <= maxLinkDepth; depth += 1) {
    let st
    try {
      st = impl.lstatSync(current)
    } catch (error) {
      const classified = classifyFsError(error, { phase: 'read', filePath: current })
      if (classified.kind === FS_MISSING) return canonicalize(current)
      throw classified
    }
    if (!st.isSymbolicLink()) return canonicalize(current)
    if (depth === maxLinkDepth) break
    let link
    try {
      link = impl.readlinkSync(current)
    } catch (error) {
      throw classifyFsError(error, { phase: 'read', filePath: current })
    }
    current = path.resolve(path.dirname(current), link)
  }
  throw new FsSafeError(FS_IO, 'ELOOP', `符号链接层数超过 ${maxLinkDepth}，疑似循环链接：${rawText}`, {
    filePath: rawText,
    phase: 'resolve',
  })
}

/**
 * 跨平台安全路径解析（永不抛错）。
 * 解开符号链接、规范化大小写，供安全检查与日志使用。
 * 需要「解析失败就拒绝」的地方请直接用 resolveWriteTarget。
 *
 * @param {string} filePath 待解析路径
 * @returns {string} 解析后的绝对规范路径
 */
export function realPathish(filePath) {
  try {
    return resolveWriteTarget(filePath)
  } catch {
    try {
      return canonicalize(path.resolve(String(filePath || '')))
    } catch {
      return path.resolve(String(filePath || ''))
    }
  }
}

/**
 * 校验目标写入路径是否落入禁止目录（如 memory/）。
 * 对符号链接、相对路径穿越（..）和平台大小写做对称严密防御。
 *
 * 解析不了（链接成环等）时【拒绝写入】：证不出落点就等于不安全。
 *
 * @param {string} targetPath 目标文件路径
 * @param {string|string[]} forbiddenRoots 禁止写入的根目录列表
 * @throws {Error} 若目标路径位于任何禁止目录内
 */
export function assertSafeWritePath(targetPath, forbiddenRoots) {
  if (!targetPath) {
    throw new FsSafeError(FS_IO, 'EINVAL', 'assertSafeWritePath: 目标路径不能为空', { phase: 'validate' })
  }
  const roots = Array.isArray(forbiddenRoots) ? forbiddenRoots : [forbiddenRoots]
  let resolvedTarget
  try {
    resolvedTarget = resolveWriteTarget(targetPath)
  } catch (error) {
    throw new Error(
      'assertSafeWritePath: 无法解析目标路径，拒绝写入 ' +
        targetPath +
        '（' +
        String((error && error.message) || error) +
        '）',
    )
  }
  const normTarget = CASE_INSENSITIVE ? resolvedTarget.toLowerCase() : resolvedTarget

  for (const root of roots) {
    if (!root) continue
    const resolvedRoot = realPathish(root)
    const normRoot = CASE_INSENSITIVE ? resolvedRoot.toLowerCase() : resolvedRoot
    if (isSameOrInside(normTarget, normRoot)) {
      throw new Error('assertSafeWritePath: 禁止写入受保护目录 ' + root + ' (target: ' + targetPath + ')')
    }
  }
}

function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    // 主线程真睡：不烧 CPU，也不用把 atomicWriteFile 变成 async。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 退化为忙等 */
    }
  }
}

/** 生成原子写入用的临时文件路径。 */
export function tempArtifactFor(filePath, options = {}) {
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid
  const nonce = options.nonce || crypto.randomBytes(6).toString('hex')
  return filePath + '.' + pid + '.' + nonce + '.tmp'
}

/** 是否为原子写入遗留的临时文件（只认自己的命名形状，不误删用户的临时文件）。 */
export function isAtomicTempName(name) {
  return TEMP_FILE_PATTERN.test(String(name || ''))
}

/**
 * 把目录变更（rename 本身）刷进磁盘。
 * POSIX 上可以打开目录句柄 fsync；Windows 不允许这样做，返回 false 而不是假装成功。
 *
 * @returns {boolean} 是否真的执行了目录 fsync
 */
export function fsyncDirSync(dir, options = {}) {
  const impl = options.fs || fs
  if (IS_WIN) return false
  let fd = -1
  try {
    fd = impl.openSync(dir, 'r')
    impl.fsyncSync(fd)
    return true
  } catch (error) {
    if (options.throwOnError) throw classifyFsError(error, { phase: 'fsync', filePath: dir })
    return false
  } finally {
    if (fd >= 0) {
      try {
        impl.closeSync(fd)
      } catch {
        /* 关不掉也不影响结论 */
      }
    }
  }
}

function renameWithRetry(impl, from, to, retries) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      impl.renameSync(from, to)
      return
    } catch (error) {
      const classified = classifyFsError(error, { phase: 'rename', filePath: to })
      lastError = classified
      if (!RENAME_RETRY_CODES.has(classified.code) || attempt === retries) break
      sleepSync(Math.min(200, 10 * 2 ** attempt))
    }
  }
  throw lastError
}

/**
 * 原子文件写入原语。
 *
 * 语义边界（很重要，别拿「原子」当「崩溃一致」）：
 * - rename 保证的是【读者永远看不到半个文件】，不是【内容已经落到盘上】。
 *   所以这里 rename 之前 fsync 数据、之后尽力 fsync 目录。进程被杀不会丢已返回的内容；
 *   断电时 POSIX 上可能回退成旧内容，但绝不会是拼接出来的半个 JSON。
 *   Windows 没有目录 fsync，只能依赖 NTFS 日志。
 * - 临时文件用 O_EXCL 独占创建，绝不跟随预先埋在那里的符号链接。
 * - 目标若是符号链接，写到链接目标上（见 resolveWriteTarget），不毁掉链接本身。
 * - rename 在 Windows 上会被杀毒 / 索引器短暂挡住，带指数退避重试。
 * - 任何失败都会清掉自己的临时文件；进程被硬杀留下的残留可用 sweepStaleTemps 扫。
 *
 * @param {string} filePath 目标文件路径
 * @param {string|Buffer} content 文件内容
 * @param {string|object} [encoding='utf8'] 字符编码；传对象当 options
 * @param {object} [options]
 * @param {boolean} [options.fsync=true] 是否 fsync 数据与目录
 * @param {boolean} [options.followSymlink=true] 目标是符号链接时是否写到链接目标
 * @param {number} [options.retries=5] rename 重试次数
 * @param {string[]} [options.forbiddenRoots] 写入前再校验一次受保护目录（收窄 TOCTOU 窗口）
 * @param {object} [options.fs] 测试用 fs 替身
 * @returns {string} 实际写入的（解析后的）目标路径
 */
export function atomicWriteFile(filePath, content, encoding = 'utf8', options = {}) {
  let opts = options
  let enc = encoding
  if (enc && typeof enc === 'object') {
    opts = enc
    enc = 'utf8'
  }
  const impl = opts.fs || fs
  const doFsync = opts.fsync !== false
  const retries = Number.isFinite(opts.retries) ? opts.retries : 5
  const encodingName = typeof enc === 'string' ? enc : 'utf8'

  let payload
  if (Buffer.isBuffer(content)) {
    payload = content
  } else if (typeof content === 'string') {
    payload = Buffer.from(content, encodingName)
  } else {
    throw new FsSafeError(FS_IO, 'EINVAL', 'atomicWriteFile: content 必须是 string 或 Buffer', {
      filePath: String(filePath || ''),
      phase: 'validate',
    })
  }

  const rawText = String(filePath || '')
  if (!rawText) throw new FsSafeError(FS_IO, 'EINVAL', 'atomicWriteFile: 目标路径不能为空', { phase: 'validate' })

  let target = path.resolve(rawText)
  if (opts.followSymlink !== false) target = resolveWriteTarget(target, { fs: impl })
  // 调用方做过安全检查，这里也要再确认一次：检查与 rename 之间的时间差是真实的 TOCTOU 窗口。
  if (opts.forbiddenRoots) assertSafeWritePath(target, opts.forbiddenRoots)

  let targetStat = null
  try {
    targetStat = impl.lstatSync(target)
  } catch (error) {
    const classified = classifyFsError(error, { phase: 'read', filePath: target })
    if (classified.kind !== FS_MISSING) throw classified
  }
  if (targetStat && targetStat.isDirectory()) {
    throw new FsSafeError(FS_IO, 'EISDIR', 'atomicWriteFile: 目标是目录 ' + target, {
      filePath: target,
      phase: 'write',
    })
  }

  const dir = path.dirname(target)
  try {
    impl.mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw classifyFsError(error, { phase: 'mkdir', filePath: dir })
  }

  let tmpPath = null
  let fd = -1
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = tempArtifactFor(target)
      try {
        fd = impl.openSync(candidate, 'wx')
        tmpPath = candidate
        break
      } catch (error) {
        const classified = classifyFsError(error, { phase: 'open', filePath: candidate })
        if (classified.code === 'EEXIST') continue
        throw classified
      }
    }
    if (fd < 0) {
      throw new FsSafeError(FS_IO, 'EEXIST', 'atomicWriteFile: 5 次随机临时名全部冲突，放弃写入', {
        filePath: target,
        phase: 'open',
      })
    }
    impl.writeFileSync(fd, payload)
    if (doFsync) impl.fsyncSync(fd)
    impl.closeSync(fd)
    fd = -1
    renameWithRetry(impl, tmpPath, target, retries)
    tmpPath = null
  } catch (error) {
    if (fd >= 0) {
      try {
        impl.closeSync(fd)
      } catch {
        /* 已经关掉了 */
      }
    }
    if (tmpPath) {
      try {
        impl.unlinkSync(tmpPath)
      } catch {
        /* 临时文件未创建或已被清理 */
      }
    }
    throw classifyFsError(error, { phase: 'write', filePath: target })
  }

  if (doFsync) fsyncDirSync(dir, { fs: impl })
  return target
}

/**
 * 原子 JSON 写入辅助函数。
 *
 * @param {string} filePath 目标文件路径
 * @param {any} data JSON 数据对象
 * @param {number|string|object} [space=2] 缩进格式；传对象当 options
 * @param {object} [options] 透传给 atomicWriteFile
 */
export function atomicWriteJson(filePath, data, space = 2, options = {}) {
  let opts = options
  let indent = space
  if (indent && typeof indent === 'object') {
    opts = indent
    indent = 2
  }
  // 先序列化再碰磁盘：循环引用这类编程错误不该留下临时文件。
  const text = JSON.stringify(data, null, indent) + '\n'
  return atomicWriteFile(filePath, text, 'utf8', opts)
}

function statTarget(impl, target) {
  try {
    return impl.statSync(target)
  } catch (error) {
    const classified = classifyFsError(error, { phase: 'read', filePath: target })
    if (classified.kind === FS_MISSING) return null
    throw classified
  }
}

/**
 * 读取文本并保留失败语义。
 *
 * 返回形状恒定，调用方按 kind 分支，不再靠 catch 一把抓：
 * - ok:true → text 可用
 * - kind:'missing' → 文件不存在（missing:true）
 * - kind:'denied' → 没权限读（不是「空文件」！）
 * - kind:'io' → 磁盘故障（也不是「空文件」！）
 *
 * @returns {{ ok: boolean, kind: string|null, missing: boolean, text: string, bytes: number, error: FsSafeError|null, filePath: string }}
 */
export function readTextTyped(filePath, options = {}) {
  const impl = options.fs || fs
  const rawText = String(filePath || '')
  const base = { ok: false, kind: null, missing: false, text: '', bytes: 0, error: null, filePath: rawText }
  if (!rawText) {
    return {
      ...base,
      kind: FS_IO,
      error: new FsSafeError(FS_IO, 'EINVAL', '读取路径不能为空', { phase: 'read' }),
    }
  }
  const target = path.resolve(rawText)
  try {
    const st = statTarget(impl, target)
    if (!st) {
      return {
        ...base,
        filePath: target,
        kind: FS_MISSING,
        missing: true,
        error: new FsSafeError(FS_MISSING, 'ENOENT', '文件不存在 ' + target, { filePath: target, phase: 'read' }),
      }
    }
    if (st.isDirectory()) {
      // 显式判定：否则 Windows 报 EPERM、POSIX 报 EISDIR，分类会随平台漂移。
      return {
        ...base,
        filePath: target,
        kind: FS_IO,
        error: new FsSafeError(FS_IO, 'EISDIR', '目标是目录而不是文件 ' + target, {
          filePath: target,
          phase: 'read',
        }),
      }
    }
    const text = impl.readFileSync(target, 'utf8')
    return {
      ok: true,
      kind: null,
      missing: false,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      error: null,
      filePath: target,
    }
  } catch (error) {
    const classified = classifyFsError(error, { phase: 'read', filePath: target })
    return {
      ok: false,
      kind: classified.kind,
      missing: classified.kind === FS_MISSING,
      text: '',
      bytes: 0,
      error: classified,
      filePath: target,
    }
  }
}

/**
 * 读取 JSON 并区分「不存在」「没权限」「内容损坏」「I/O 故障」。
 * 空文件和语法错误都算 corrupt —— 它们绝不能退化成「当作空对象继续」。
 *
 * @returns {{ ok: boolean, kind: string|null, missing: boolean, value: any, raw?: string, bytes: number, error: FsSafeError|null, filePath: string }}
 */
export function readJsonTyped(filePath, options = {}) {
  const base = readTextTyped(filePath, options)
  if (!base.ok) return { ...base, value: undefined }
  const rawContent = base.text
  if (!rawContent.trim()) {
    return {
      ...base,
      ok: false,
      kind: FS_CORRUPT,
      value: undefined,
      raw: rawContent,
      error: new FsSafeError(FS_CORRUPT, 'EEMPTY', 'JSON 文件为空 ' + base.filePath, {
        filePath: base.filePath,
        phase: 'parse',
      }),
    }
  }
  try {
    return { ...base, value: JSON.parse(rawContent), raw: rawContent }
  } catch (cause) {
    return {
      ...base,
      ok: false,
      kind: FS_CORRUPT,
      value: undefined,
      raw: rawContent,
      error: new FsSafeError(FS_CORRUPT, 'EBADJSON', 'JSON 解析失败 ' + base.filePath + ': ' + cause.message, {
        filePath: base.filePath,
        phase: 'parse',
        cause,
      }),
    }
  }
}

/**
 * 逐行读 JSONL：单行损坏不该让整份存档不可用，但坏行必须被点名。
 *
 * @returns {{ ok: boolean, kind: string|null, missing: boolean, records: any[], corruptLines: object[], lines: number, bytes: number, error: FsSafeError|null, filePath: string }}
 */
export function readJsonlTyped(filePath, options = {}) {
  const base = readTextTyped(filePath, options)
  if (!base.ok) {
    return {
      ok: false,
      kind: base.kind,
      missing: base.missing,
      records: [],
      corruptLines: [],
      lines: 0,
      bytes: base.bytes,
      error: base.error,
      filePath: base.filePath,
    }
  }
  const records = []
  const corruptLines = []
  const rows = base.text.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i]
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (cause) {
      corruptLines.push({ line: i + 1, text: line.slice(0, 120), error: String(cause.message) })
    }
  }
  return {
    ok: true,
    kind: corruptLines.length ? FS_CORRUPT : null,
    missing: false,
    records,
    corruptLines,
    lines: records.length + corruptLines.length,
    bytes: base.bytes,
    error: corruptLines.length
      ? new FsSafeError(FS_CORRUPT, 'EBADJSON', 'JSONL 有 ' + corruptLines.length + ' 行无法解析 ' + base.filePath, {
          filePath: base.filePath,
          phase: 'parse',
        })
      : null,
    filePath: base.filePath,
  }
}

/**
 * 追加 JSONL 并 fsync。
 *
 * 顺序契约：【先让数据落盘，再写水位】。否则断电后可能出现
 * 「水位说处理过了、数据里却没有」—— 那才是真正需要人工介入的不一致。
 *
 * @param {string} filePath JSONL 路径（符号链接会被跟随）
 * @param {object|object[]|string|string[]} records 记录（对象或已是 JSON 字符串）
 * @param {{ fsync?: boolean, fs?: object }} [options]
 * @returns {{ appended: number, bytes: number, fsynced: boolean, filePath: string }}
 */
export function appendJsonlDurable(filePath, records, options = {}) {
  const impl = options.fs || fs
  const list = Array.isArray(records) ? records : [records]
  const rawText = String(filePath || '')
  if (!rawText) throw new FsSafeError(FS_IO, 'EINVAL', 'appendJsonlDurable: 目标路径不能为空', { phase: 'validate' })
  if (!list.length) return { appended: 0, bytes: 0, fsynced: false, filePath: path.resolve(rawText) }

  const lines =
    list.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n') + '\n'
  const payload = Buffer.from(lines, 'utf8')
  const target = resolveWriteTarget(path.resolve(rawText), { fs: impl })
  const dir = path.dirname(target)
  try {
    impl.mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw classifyFsError(error, { phase: 'mkdir', filePath: dir })
  }

  const doFsync = options.fsync !== false
  let fd = -1
  try {
    fd = impl.openSync(target, 'a')
    impl.writeFileSync(fd, payload)
    if (doFsync) impl.fsyncSync(fd)
  } catch (error) {
    throw classifyFsError(error, { phase: 'write', filePath: target })
  } finally {
    if (fd >= 0) {
      try {
        impl.closeSync(fd)
      } catch {
        /* 已经关掉了 */
      }
    }
  }
  if (doFsync) fsyncDirSync(dir, { fs: impl })
  return { appended: list.length, bytes: payload.length, fsynced: doFsync, filePath: target }
}

/**
 * 清理进程被硬杀后遗留的原子写入临时文件。
 * 只认 TEMP_FILE_PATTERN 且超过保留时长的文件 —— 不误删别的进程刚创建的临时文件，
 * 也不碰用户自己的 *.tmp。
 *
 * @param {string} dir 目录
 * @param {{ olderThanMs?: number, now?: number, dryRun?: boolean, fs?: object }} [options]
 * @returns {{ dir: string, scanned: number, matched: number, removed: string[], kept: string[], errors: object[] }}
 */
export function sweepStaleTemps(dir, options = {}) {
  const impl = options.fs || fs
  const olderThanMs = Number.isFinite(options.olderThanMs) ? options.olderThanMs : 60_000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const out = {
    dir: path.resolve(String(dir || '')),
    scanned: 0,
    matched: 0,
    removed: [],
    kept: [],
    errors: [],
  }
  let names
  try {
    names = impl.readdirSync(out.dir)
  } catch (error) {
    out.errors.push(classifyFsError(error, { phase: 'list', filePath: out.dir }))
    return out
  }
  for (const name of names) {
    out.scanned += 1
    if (!isAtomicTempName(name)) continue
    out.matched += 1
    const full = path.join(out.dir, name)
    let st
    try {
      st = impl.statSync(full)
    } catch (error) {
      out.errors.push(classifyFsError(error, { phase: 'read', filePath: full }))
      continue
    }
    if (now - st.mtimeMs < olderThanMs) {
      out.kept.push(name)
      continue
    }
    if (options.dryRun) {
      out.kept.push(name)
      continue
    }
    try {
      impl.unlinkSync(full)
      out.removed.push(name)
    } catch (error) {
      out.errors.push(classifyFsError(error, { phase: 'unlink', filePath: full }))
    }
  }
  return out
}

function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 数据文件与水位/状态文件的对账（启动恢复用）。
 *
 * 唯一真相是【数据文件】：水位只是「哪些已经处理过」的加速缓存。
 * 崩溃可能留下的三种坏状态都由这里收拾：
 * - watermark 落后于数据（先落数据后写水位，正常的中断形态）→ 用数据里的 id 补齐
 * - watermark 超前于数据（水位写成了但数据追加丢了）→ 丢掉水位里的幽灵 id
 * - watermark 缺失 / 损坏 → 从数据重建
 * 而 watermark【读不了】（没权限 / I/O 故障）时一律不动它：
 * 读不到不等于没有，覆写会把仅存的证据毁掉。
 * 数据文件缺失或本身损坏时也不写 —— 那是要人来判断的事故，不是能自动抹平的偏差。
 *
 * @param {object} options
 * @param {string} options.dataFile 数据文件（JSONL）
 * @param {string} options.watermarkFile 水位文件（JSON）
 * @param {(records: any[], readResult: object) => string[]} [options.readIds] 从数据记录取 id
 * @param {(watermark: object) => string[]} [options.readWatermarkIds] 从水位对象取已处理 id
 * @param {(ids: string[], previous: object) => object} [options.renderWatermark] 重建水位（保留额外字段）
 * @param {boolean} [options.tolerateCorruptData=false] 数据有坏行时是否继续对账
 * @param {boolean} [options.dryRun=false] 只算不写
 * @param {object} [options.fs] 测试用 fs 替身
 */
export function reconcileWatermark(options = {}) {
  const impl = options.fs || fs
  const dataFile = options.dataFile
  const watermarkFile = options.watermarkFile
  const readIds =
    typeof options.readIds === 'function'
      ? options.readIds
      : (records) => records.map((record) => (record && record.id) || '')
  const readWatermarkIds =
    typeof options.readWatermarkIds === 'function'
      ? options.readWatermarkIds
      : (watermark) => (Array.isArray(watermark && watermark.ids) ? watermark.ids : [])
  const renderWatermark =
    typeof options.renderWatermark === 'function'
      ? options.renderWatermark
      : (ids, previous) => ({ ...(previous && typeof previous === 'object' ? previous : {}), ids: [...ids] })

  const out = {
    status: 'unknown',
    repaired: false,
    written: false,
    dryRun: !!options.dryRun,
    data: null,
    watermark: null,
    dataIds: [],
    watermarkIds: [],
    missingFromWatermark: [],
    missingFromData: [],
    error: null,
  }
  if (!dataFile || !watermarkFile) {
    out.status = 'error'
    out.error = new FsSafeError(FS_IO, 'EINVAL', 'reconcileWatermark: 需要 dataFile 与 watermarkFile', {
      phase: 'validate',
    })
    return out
  }

  const dataRead = readJsonlTyped(dataFile, { fs: impl })
  const dataIds = dataRead.ok ? uniqueStrings(readIds(dataRead.records, dataRead)) : []
  out.data = {
    ok: dataRead.ok,
    kind: dataRead.kind,
    missing: dataRead.missing,
    count: dataRead.records.length,
    corruptLines: dataRead.corruptLines,
    filePath: dataRead.filePath,
  }

  const wmRead = readJsonTyped(watermarkFile, { fs: impl })
  const wmValue =
    wmRead.ok && wmRead.value && typeof wmRead.value === 'object' && !Array.isArray(wmRead.value)
      ? wmRead.value
      : null
  const wmIds = wmValue ? uniqueStrings(readWatermarkIds(wmValue)) : []
  out.dataIds = dataIds
  out.watermarkIds = wmIds
  out.watermark = {
    ok: wmRead.ok,
    kind: wmRead.kind,
    missing: wmRead.missing,
    count: wmIds.length,
    value: wmValue,
    filePath: wmRead.filePath,
  }

  // ① 数据文件读不到 / 不存在 → 唯一真相不在，绝不改水位。
  if (!dataRead.ok) {
    out.status = dataRead.missing ? 'data_missing' : dataRead.kind === FS_CORRUPT ? 'data_corrupt' : 'data_unreadable'
    out.error = dataRead.error
    return out
  }
  // ② 数据里有坏行 → 报出来，默认不自动收敛。
  if (dataRead.corruptLines.length && options.tolerateCorruptData !== true) {
    out.status = 'data_corrupt'
    out.error = dataRead.error
    return out
  }

  const dataSet = new Set(dataIds)
  const wmSet = new Set(wmIds)
  out.missingFromWatermark = dataIds.filter((id) => !wmSet.has(id))
  out.missingFromData = wmIds.filter((id) => !dataSet.has(id))

  // ③ 水位读不了（没权限 / I/O）→ 不动它。只有缺失和损坏才是可重建的。
  if (!wmRead.ok && wmRead.kind !== FS_MISSING && wmRead.kind !== FS_CORRUPT) {
    out.status = 'watermark_unreadable'
    out.error = wmRead.error
    return out
  }

  let status
  if (!wmRead.ok) {
    status = wmRead.missing ? 'watermark_missing' : 'watermark_corrupt'
  } else if (out.missingFromData.length && out.missingFromWatermark.length) {
    status = 'divergent'
  } else if (out.missingFromData.length) {
    status = 'ahead'
  } else if (out.missingFromWatermark.length) {
    status = 'behind'
  } else {
    status = 'consistent'
  }
  out.status = status
  if (status === 'consistent') return out

  out.repaired = true
  if (options.dryRun) return out

  const next = renderWatermark(dataIds, wmValue || {})
  try {
    atomicWriteJson(watermarkFile, next, 2, {
      fs: impl,
      ...(options.forbiddenRoots ? { forbiddenRoots: options.forbiddenRoots } : {}),
    })
    out.written = true
  } catch (error) {
    out.status = 'repair_failed'
    out.error = classifyFsError(error, { phase: 'write', filePath: watermarkFile })
  }
  return out
}
