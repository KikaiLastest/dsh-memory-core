import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 跨平台安全路径解析。
 * 解开所有符号链接（包括父目录为软链、悬空链接等情况），
 * 统一大小写（在不区分大小写的文件系统下）。
 *
 * @param {string} filePath 待解析路径
 * @returns {string} 解析后的真实绝对规范路径
 */
export function realPathish(filePath) {
  let current = path.resolve(String(filePath || ''))
  try {
    if (fs.lstatSync(current).isSymbolicLink()) {
      current = path.resolve(path.dirname(current), fs.readlinkSync(current))
    }
  } catch {
    /* 不是链接或读不到，按原路径继续 */
  }
  try {
    return fs.realpathSync(current)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(current)), path.basename(current))
    } catch {
      return current
    }
  }
}

/**
 * 校验目标写入路径是否落入禁止目录（如 memory/）。
 * 对符号链接、相对路径穿越（..）和平台大小写做对称严密防御。
 *
 * @param {string} targetPath 目标文件路径
 * @param {string|string[]} forbiddenRoots 禁止写入的根目录列表
 * @throws {Error} 若目标路径位于任何禁止目录内
 */
export function assertSafeWritePath(targetPath, forbiddenRoots) {
  if (!targetPath) {
    throw new Error('assertSafeWritePath: 目标路径不能为空')
  }
  const roots = Array.isArray(forbiddenRoots) ? forbiddenRoots : [forbiddenRoots]
  const resolvedTarget = realPathish(targetPath)
  const normTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget

  for (const root of roots) {
    if (!root) continue
    const resolvedRoot = realPathish(root)
    const normRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot

    // 完全重合，或是其子路径
    if (normTarget === normRoot || normTarget.startsWith(normRoot + path.sep)) {
      throw new Error(`assertSafeWritePath: 禁止写入受保护目录 ${root} (target: ${targetPath})`)
    }
  }
}

/**
 * 原子文件写入原语。
 * 1. 使用带进程 PID 和高熵随机十六进制后缀的独立临时文件，彻底消灭并发写竞争；
 * 2. 递归确保目录存在；
 * 3. 写入临时文件后执行 atomic rename；
 * 4. 写入失败时自动清理临时文件，不留垃圾。
 *
 * @param {string} filePath 目标文件路径
 * @param {string|Buffer} content 文件内容
 * @param {string} [encoding='utf8'] 字符编码
 */
export function atomicWriteFile(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const rand = crypto.randomBytes(6).toString('hex')
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`
  try {
    fs.writeFileSync(tmp, content, encoding)
    fs.renameSync(tmp, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件未创建或已被清理 */
    }
    throw error
  }
}

/**
 * 原子 JSON 写入辅助函数。
 *
 * @param {string} filePath 目标文件路径
 * @param {any} data JSON 数据对象
 * @param {number|string} [space=2] 缩进格式
 */
export function atomicWriteJson(filePath, data, space = 2) {
  atomicWriteFile(filePath, JSON.stringify(data, null, space) + '\n', 'utf8')
}
