/**
 * 查询侧同义词扩展。
 *
 * 只作用于查询，索引和打分公式一概不动。
 * 触发条件很窄：严格检索一条都没命中时，才拿这张表再试一次。
 *
 * 两组语义要分开，混在一起是设计错误：
 * - synonym：明确等价的缩写或异名，扩展权重可以用高一点。
 * - related：只是常在同一语境出现的相关概念，扩展权重压低，
 *   而且**不能单独满足原始命中的门槛**。
 *
 * 表是给人改的。发现某个说法永远搜不到，就在这里加一行。
 */
export const GROUPS = [
  // 部署语境里的相关概念。注意这不是"同义词"——
  // "环境"和"部署"不能互相替换，它们只是常一起出现。
  {
    kind: 'related',
    weight: 0.4,
    words: ['部署', '上线', '跑在', '主机', '机器', '服务器', '环境'],
  },
  { kind: 'synonym', weight: 0.8, words: ['端口', 'port', '监听'] },
  { kind: 'synonym', weight: 0.8, words: ['缓存', 'cache', '缓冲'] },
  { kind: 'synonym', weight: 0.8, words: ['改主意', '改成', '换成', '改用', '推翻'] },
  { kind: 'synonym', weight: 0.8, words: ['数据库', 'db'] },
  // 饮食限制。同样只是相关，不是同义词：忌口不等于过敏。
  { kind: 'related', weight: 0.4, words: ['不吃', '忌口', '不爱吃'] },

  // 「过敏」故意不放进任何一组。
  // 饮食安全的词不能靠"相关概念"去捞——把它和"不爱吃"混在一起，
  // 错的代价是安全问题，不是召回率问题。要支持它，应该单独做一条规则。
]

/**
 * 找出文本里命中的组，返回组内**其他**词和这一轮该用的扩展权重。
 * 同一个查询命中多组时取最大的那个权重（保守：不叠加）。
 * @param {string} text
 * @returns {{ words: string[], weight: number }}
 */
export function expandWords(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  let weight = 0
  for (const group of GROUPS) {
    const hits = group.words.filter((w) => t.includes(w.toLowerCase()))
    if (hits.length === 0) continue
    weight = Math.max(weight, group.weight)
    for (const w of group.words) {
      if (!hits.includes(w)) out.add(w)
    }
  }
  return { words: [...out], weight }
}
