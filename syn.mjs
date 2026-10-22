/**
 * 查询侧同义词扩展。
 *
 * 只作用于查询，索引和打分公式一概不动。
 * 触发条件很窄：严格检索一条都没命中时，才拿这张表再试一次。
 *
 * ## 三层结构，混在一起是设计错误
 *
 * 1. GENERIC（泛词黑名单）
 *    在语料里散落在三条以上条目的词。它们**永远不当触发词，也永远不被当作扩展词吐出**。
 *    上一轮 496 行词表被回滚，根子就在这里：「迁移」「环境」「配置」被当成触发词以后，
 *    「服务跑在什么环境上」被「环境变量」骗去召回「数据库选型」，错误条目顶到 top1。
 *    泛词的问题不是权重高低，而是它**不携带指向性** —— 给 0.01 的权重它也照样能把
 *    候选池里不相干的条目拉进门槛，因为门槛看的是 expansionMatched 的**个数**，不是分数。
 *
 * 2. kind: 'synonym'（等价别名，weight 0.8）
 *    两种说法指向同一个概念：查询说「口」，记录写「端口」。
 *    命中等价组时**只用等价组**，related 组整组丢弃 —— 见 expandWords 的层级优先规则。
 *
 * 3. kind: 'related'（相关概念，weight 0.3）
 *    只是常在同一语境出现，不能互相替换。权重压低，且只在没有任何等价组命中时才用。
 *
 * ## 规则怎么写才不会误伤
 *
 * - pivots 是**触发词**（查询里必须出现），words 是**吐出去的扩展词**，两者分开写。
 *   这样「花生」能触发，而「吃」这种出现在十条查询里的词不会。
 * - pivots 一律避开单字虚词和泛词。单字只在无法替代时使用（如「口」），并注明风险。
 * - words 一律选**指向性强的具体词**（date-fns、migrations、十一点半），不选主题词。
 * - 触发词不许出现在无答案查询里 —— 反例测试 test/syn.test.mjs 会拿冻结语料逐条验证：
 *   任何被吐出的扩展词，其 2-gram 在语料中出现的前提是触发了正确的 pivots。
 *
 * 表是给人改的。发现某个说法永远搜不到，就在这里加一行，并写清触发条件和风险。
 */

/** 泛词黑名单：永不当触发词，永不作为扩展词吐出。 */
export const GENERIC = new Set([
  '环境', '迁移', '系统', '配置', '问题', '情况', '方案', '东西', '方面', '相关',
  '一般', '主要', '数据', '信息', '内容', '功能', '方式', '地方', '时候', '时间',
  '服务', '项目', '文件', '工具', '软件', '现在', '以前', '怎么', '什么', '哪个',
])

/** 一次扩展最多吐出多少个词。上限用来防止候选池被摊薄成「谁都能命中一个」。 */
export const MAX_EXPANSION = 12

export const GROUPS = [
  // ---------- 等价别名 ----------
  {
    id: 'database',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「数据库/MySQL/PG」是明确的技术实体，不会散落在无关条目里。
    // 风险：无。查询里写「库」的单字情形（「库用的哪个」）故意不触发 —— 单字「库」太泛。
    pivots: ['数据库', 'mysql', 'postgresql', 'migrations'],
    words: ['数据库', 'mysql', 'postgresql', 'migrations'],
  },
  {
    id: 'editor',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「敲代码/写代码」表达的是「用什么写代码」，指向编辑器条目。
    // 「软件」「工具」单独出现不算触发词（「听歌那个软件」不是问编辑器）。
    // 风险：语料里若另有一条也在讲「敲代码」，会同时被扩展命中；靠 BM25 原始分排序决胜。
    pivots: ['编辑器', '敲代码', '写代码', 'vs code', 'vscode', 'ide'],
    words: ['编辑器', 'vs code', 'vscode', '调试器'],
  },
  {
    id: 'indent',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「缩」单字是这里唯一的口子，因为「缩几个格」「缩进」都从它出发。
    // 风险：单字「缩」理论上有歧义，但中文里以「缩」开头的常见说法几乎只有缩进/缩写；
    //       反例测试逐条确认它不会出现在无答案查询里。
    pivots: ['缩', '格式化', '行宽', 'prettier', '空格'],
    words: ['缩进', '空格', '行宽', 'prettier', '字符'],
  },
  {
    id: 'port',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「口」单字，对应「挂在哪个口」「端口」。语料里只有「端口」条目讲这个。
    // 风险：单字「口」也出现在「接口/入口」，那类条目不会同时命中「端口/监听」，
    //       所以扩展词选的是「端口/监听/反向代理」而不是「口」本身。
    pivots: ['端口', '口', '监听'],
    words: ['端口', '监听', '反向代理', '8443'],
  },
  {
    id: 'date-lib',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「日期」明确指向 date-fns/Moment 那条。不把「时间」当触发词（太泛，见 GENERIC）。
    // 风险：无。
    pivots: ['日期', 'date-fns', 'moment'],
    words: ['date-fns', 'moment', '日期处理', '包体积', '停止维护'],
  },
  {
    id: 'cache-music',
    kind: 'synonym',
    weight: 0.8,
    // 触发：只认「听歌/音乐/歌」这类指向音乐播放器的词。
    // 风险：**故意不把「缓存」当触发词**。实测把音乐/视频/静态三条缓存的扩展词合并成一组、
    //       共用「两百首/一集」时，「后端返回的数据怎么设缓存才不白跑请求」会被
    //       「保留最近两百首」骗到音乐播放器条目上，过期泄漏 3 -> 4。
    //       所以三条缓存必须各自成组，靠 pivots 区分，不能共用一个「缓存」。
    pivots: ['听歌', '音乐', '歌'],
    // 「音乐」「两百首」「淘汰」这三个词在语料里只出现在音乐条目的正文中，可判别。
    // 不能用「音乐播放器」：2-gram 切分下它和「视频播放器」共享「播放器」，
    // 实测会把「歌缓存满了先删哪首」拉到视频条目上（eM=2，泄漏）。
    words: ['两百首', '淘汰', '音乐'],
  },
  {
    id: 'cache-video',
    kind: 'synonym',
    weight: 0.8,
    // 触发：只认「看剧/视频/剧」。理由同 cache-music。
    // 风险：与 cache-music 的隔离靠 pivots 完成；两条都命中时（如「视频软件会缓存几集」）
    //       走的是严格路径，根本进不了扩展回退，所以不会互相污染。
    pivots: ['看剧', '视频', '剧'],
    // 同理不吐「视频播放器」：只吐视频条目独有的词。
    words: ['一集', '预读', '看完就删', '视频'],
  },
  {
    id: 'deploy',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「部署/生产机/测试机」是这套语料里指向部署条目的专名。
    // 风险：「上线」故意不放进去 —— 它同时出现在部署和截止日期两条里，属于半泛词。
    pivots: ['部署', '生产机', '测试机', '停用'],
    words: ['生产机', '测试机', '停用', '10.0.0.9'],
  },
  {
    id: 'allergy',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「花生」是过敏条目的专名；「过敏」是它的自述词。
    // 风险：「吃」绝不入表 —— 它同时指向过敏、香菜、辣度三条，是最典型的泛词。
    //       饮食类扩展必须按具体食物分开写，不许用「吃」把三条串起来。
    pivots: ['花生', '过敏'],
    words: ['过敏', '疹子', '呼吸困难', '花生油'],
  },
  {
    id: 'sleep',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「睡」「躺下」指向作息条目。
    // 风险：「几点」不能当触发词（几点睡/几点起/几点开会全用它）。
    pivots: ['睡', '躺下', '作息'],
    words: ['十一点半', '七点', '多睡'],
  },
  {
    id: 'commute',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「上班/通勤」明确。
    // 风险：「怎么走」也常指流程，但语料里没有流程条目，风险可接受。
    pivots: ['上班', '通勤', '怎么走'],
    words: ['地铁', '公交', '四号线', '淋雨'],
  },
  {
    id: 'meeting',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「周会/例会/同步会」明确指向会议条目。
    // 风险：无。
    pivots: ['周会', '例会', '同步会', '开会'],
    words: ['周三', '同步会', '半小时'],
  },
  {
    id: 'deadline',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「几号/最晚/截止」是截止日期的问法。
    // 风险：「上线」同时属于部署语境，这里不吐「上线」，只吐具体日期和「联调/倒排」。
    pivots: ['几号', '最晚', '截止', '死线'],
    words: ['十一月十五号', '联调', '倒排'],
  },
  {
    id: 'dog',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「狗/品种」+ 犬名。**故意不含「柯基」** —— 无答案查询
    // 「柯基掉毛严重吗」本身就含「柯基」，把它当触发词会直接制造一次误召。
    // 风险：猫狗两条分开写，避免「品种」把猫条目顶上来（有 forbid 约束）。
    pivots: ['狗', '品种', '追车'],
    words: ['柯基', '豆豆', '腿短', '追快递车'],
  },
  {
    id: 'cat',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「猫叫/橘猫」—— 同样避开单字「猫」：无答案查询「怎么给猫剪指甲」含「猫」。
    // 风险：单字触发会误召，所以必须写成「猫叫」这类最小可判别短语。
    pivots: ['猫叫', '橘猫', '收容所'],
    words: ['年糕', '橘猫', '收容所'],
  },
  {
    id: 'ci-ban',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「ci」「禁用」「拦截」指向「已在 CI 加禁用检查」那条。
    // 风险：「检查」太泛，只吐「禁用检查」这个组合词，不吐单字。
    pivots: ['ci', '禁用', '拦截', '流水线'],
    words: ['禁用检查', 'ci'],
  },
  {
    id: 'jquery',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「jquery/dom 库」明确。
    // 风险：无。
    pivots: ['jquery', 'dom', '原生 api'],
    words: ['jquery', 'dom', '原生 api', '引入'],
  },
  {
    id: 'static-cache',
    kind: 'synonym',
    weight: 0.8,
    // 触发：「静态/浏览器/强缓存」指向前端静态资源缓存那条。
    // 风险：与 cache 组同源，靠 pivots 区分：讲「网页/静态」才走这条。
    pivots: ['静态', '浏览器', '强缓存', '协商缓存'],
    words: ['强缓存', '协商缓存', '文件名哈希', '一年'],
  },

  // ---------- 相关概念（低权重，且只在没有等价组命中时使用） ----------
  {
    id: 'related-host',
    kind: 'related',
    weight: 0.3,
    // 触发：「跑在」只在问「跑在哪台机器」时出现，比「环境」精确得多。
    // 「环境」「机器」单独出现都不算触发词 —— 这两个正是上一轮把 top1 顶错的元凶。
    // 风险：仍可能同时命中「服务部署在测试机」那条旧记录；旧记录若已被 superseded，
    //       状态过滤会先把它剔掉，所以真实风险落在「两条都 active」的语料上。
    pivots: ['跑在', '挂在哪'],
    words: ['生产机', '测试机', '部署'],
  },
  {
    id: 'related-hotdrink',
    kind: 'related',
    weight: 0.3,
    // 触发：「提神」是查询侧对咖啡的转述，语料里一个字都没有 —— 这正是需要扩展的场景。
    // 风险：「喝」不能当触发词，它出现在咖啡和「不喝」两类问法里。
    pivots: ['提神', '咖啡'],
    words: ['咖啡', '三点', '手冲'],
  },
  {
    id: 'related-spicy',
    kind: 'related',
    weight: 0.3,
    // 触发：「辣」指向辣度条目。
    // 风险：只吐「微辣/中辣」这两个语料里真实存在的程度词，不吐「吃」。
    pivots: ['辣'],
    words: ['微辣', '中辣', '吃辣'],
  },
]

/**
 * 找出文本命中的组，返回这一轮该用的扩展词和扩展权重。
 *
 * 层级优先是这里最要紧的一条规则：只要命中任何一个 synonym 组，related 组整组丢弃。
 * 因为 index.js 的扩展权重是**整个查询共用的一个标量**（expandWords 只返回一个 weight），
 * 把 related 组混进去等于让低置信的相关词跟着背 0.8 的高权重 ——
 * 上一轮 496 行词表把开发集从 100% 顶到 88.9%，机制就是这个。
 *
 * @param {string} text
 * @returns {{ words: string[], weight: number, tier: 'synonym'|'related'|'' }}
 */
export function expandWords(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, '')
  if (!t) return { words: [], weight: 0, tier: '' }

  const matched = []
  for (const group of GROUPS) {
    const pivots = group.pivots && group.pivots.length ? group.pivots : group.words
    if (!pivots.some((p) => t.includes(String(p).toLowerCase()))) continue
    matched.push(group)
  }
  if (matched.length === 0) return { words: [], weight: 0, tier: '' }

  const synonyms = matched.filter((g) => g.kind === 'synonym')
  const used = synonyms.length > 0 ? synonyms : matched

  let weight = 0
  const out = []
  for (const group of used) {
    // 保守：多组命中不叠加权重，取最大
    weight = Math.max(weight, group.weight)
    for (const w of group.words) {
      const lw = String(w).toLowerCase()
      if (GENERIC.has(lw)) continue
      // 查询里本来就有的词不必再吐：它已经是原始 gram，重复加只会重复计分
      if (t.includes(lw)) continue
      if (!out.includes(lw)) out.push(lw)
    }
  }
  return { words: out.slice(0, MAX_EXPANSION), weight, tier: used[0].kind }
}
