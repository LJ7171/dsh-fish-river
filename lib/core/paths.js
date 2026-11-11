/**
 * paths.js —— 路径包含关系的唯一实现。
 *
 * 这个判断以前在 album / meme / sendImage 各有一份，四份里只要有一份漏了
 * `isAbsolute`，就是一个路径穿越洞。统一到这里，配一组边界测试。
 *
 * 两个语义：
 *   isInside        —— parent 本身也算（用于「这个文件属于这个目录树」）
 *   isInsideStrict  —— parent 本身不算（用于「必须是子文件/子目录」）
 */
import { isAbsolute, relative } from 'node:path'

export function isInside(parent, child) {
  if (!parent || !child) return false
  const rel = relative(String(parent), String(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function isInsideStrict(parent, child) {
  if (!parent || !child) return false
  const rel = relative(String(parent), String(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export default { isInside, isInsideStrict }
