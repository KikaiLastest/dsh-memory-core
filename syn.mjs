/**
 * 查询侧同义词扩展。
 *
 * 只作用于查询，索引和打分公式一概不动。
 * 用途很窄：严格检索一条都没命中时，拿这张表再试一次。
 *
 * 表是给人改的。发现某个说法永远搜不到，就在这里加一行——
 * 不需要懂 BM25，也不会影响别的查询。
 */
export const GROUPS = [
  ['部署', '环境', '机器', '服务器', '上线', '跑在', '主机'],
  ['数据库', '存储', 'db'],
  ['缓存', 'cache', '缓冲'],
  ['端口', 'port', '监听'],
  ['不吃', '忌口', '过敏', '不爱吃'],
  ['改主意', '改成', '换成', '改用', '推翻'],
]

/**
 * 找出文本里命中的同义词组，返回组内**其他**词（不含原词本身）。
 * @param {string} text
 * @returns {string[]}
 */
export function expandWords(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  for (const group of GROUPS) {
    const hit = group.find((word) => t.includes(word.toLowerCase()))
    if (!hit) continue
    for (const word of group) {
      if (word.toLowerCase() !== hit.toLowerCase()) out.add(word)
    }
  }
  return [...out]
}
