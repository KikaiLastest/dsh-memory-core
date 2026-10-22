# 捕获副本的身份接入（IDENTITY-INTEGRATION）

> 范围：只解决「正文已标记 superseded，但自动捕获副本仍被召回」。
> 不改变 status.mjs 的判定权；autocapture.mjs 只负责把身份变得可解析。
> 集成前本文件不生效：index.js 仍只把捕获记录投影成 `{id,src,line,text,...}`。

## 1. 规范身份

- `canonicalBody(text)`：统一 CRLF、去首尾空白、去掉第一行 Markdown 标题；正文内部不动。
- `bodyId(text) = idOf(canonicalBody(text))`：同一段正文的原文/摘要/捕获副本共用的**正文身份**。
- `captureContentId(record)`：显式 `contentId` → 落盘 `bodyId` → 现算 `bodyId(text)`。
- `linkCaptureToSource(record, candidates)`：在 `src === 'dialogue'` 的候选里按「去空白后的正文包含关系」找出处，回填
  - `contentId = idOf(整节原文.trim())`（structured.jsonl 的 `id`）
  - `sourceId = entry.sourceId || entry.id`（`dialogue:行号`）
- `toCaptureEntry(record, candidates)`：index.js 读取侧的投影函数，输出和原对象字面量同形，另带 `contentId/sourceId`。

为什么是两层：状态表目前只认 `idOf(整节原文)`（consolidate.mjs:83），摘要也用同一套（summary.mjs:530）；捕获文本只是小节正文的一部分，单靠正文哈希查不到表。正文哈希是**匹配键**，整节哈希是**状态键**。

## 2. 落盘字段

`autoCapture` 现在会在每条 JSONL 里写：

```json
{
  "id": "cap-...",
  "text": "捕获正文",
  "contentId": "mem-...",
  "bodyId": "mem-...",
  "sourceId": null,
  "type": "auto_capture",
  "weight": 1,
  "created_at": "...",
  "source": "dialogue"
}
```

- 不传 `contentId` 时 `contentId = bodyId = idOf(canonicalBody(text))`，保证每条捕获都自带正文身份。
- `sourceId` 只有调用方确实知道坐标时才写，不知道就写 `null`，不猜。
- 旧记录没有这两个字段也能读；`captureContentId` 会现算。

## 3. 集成点（index.js，基于 76a81fc）

### 3.1 唯一必需改动：读取侧

- 文件：`index.js`
- **第 7 行** import 加 `toCaptureEntry`：

```diff
- import { autoCapture, readCaptureStore } from './autocapture.mjs'
+ import { autoCapture, readCaptureStore, toCaptureEntry } from './autocapture.mjs'
```

- **第 143-155 行**，把 `for (const c of captured) { ... entries.push({...}) }` 整段替换为：

```js
    for (const c of captured) {
      if (c && c.text && c.text.length >= 5) entries.push(toCaptureEntry(c, entries))
    }
```

- 插入点必须在 dialogue 条目已经 push 之后（当前就是）；传的是捕获循环开始前的 `entries`。
- 不需要改 `loadEntries` 的其他地方；`toCaptureEntry` 对无 text 的输入返回 null，已有 if 会挡掉。

### 3.2 可选：写入侧带坐标

当前 `agent/pre-step` 只有用户消息文本，不知道未来会落到对话文件哪一行，所以 **autoCapture 调用处不需要改**。若上游以后能拿到坐标，可加：

```js
autoCapture({ ..., sourceId: 'dialogue:123', contentId: idOf(sectionText) })
```

有 `sourceId` 时，即使正文后来被轻微编辑，也还能按坐标查状态；这条不在本次默认路径里。

## 4. 集成后如何验证「正文 superseded → 捕获副本不再召回」

### 4.1 跑回归

```bash
node test/identity-capture.test.mjs
```

断言链：

1. `captureContentId(record) === idOf(同一段正文)`；
2. 原文 / 摘要 / 捕获三个副本的 `resolveEntryStatus(..., statusMap)` 都等于 `'superseded'`；
3. `filterRecallableEntries([linked], statusMap).recallable.length === 0`，且 `suppressed === 1`；
4. 新方案（active）的捕获副本仍可召回，证明不是一刀切；
5. 未接身份的旧投影 `resolveEntryStatus === null` 且 `isRecallable(null) === true`，复现缺陷前提，证明接入不是摆设。

> 本分支按约束没有改 `package.json`。集成者需在 `scripts.test` 链里加
> `node test/identity-capture.test.mjs`；在接进主链之前，`npm test` 会因
> `pack.test.mjs` 的「每个 test/*.test.mjs 必须被 npm script 引用」检查而红，
> 单独跑该文件是绿的。

### 4.2 真实召回

构造或复用临时档案后：

```js
import assert from 'node:assert'
import { recall, invalidateMemoryCache } from './index.js'

invalidateMemoryCache()
const hits = recall(cfg, '旧缓存方案')
assert.ok(!hits.some((hit) => hit.entry.text.includes('旧的缓存方案')), '淘汰正文的捕获副本不得再召回')
```

观察点：候选池里该捕获条目的 `contentId` 应等于 structured.jsonl 里旧记录的 `id`，`sourceId` 应等于它的 `source_id`；若仍是正文哈希或 null，说明 `toCaptureEntry` 没接上，或候选里没有对应的 dialogue 条目。

## 5. 这个方案没有解决什么（明确边界）

1. **捕获正文被编辑 / 改写**：识别不出。`bodyId` 按落盘文本计算；用户把捕获副本改一个字，或原文被改写后不再是逐字子串，包含匹配失败，`contentId` 回落到正文哈希，状态表查不到 → 仍可能被召回。没有原文坐标就无解；要么禁止编辑捕获文本，要么写入时带 `sourceId`。
2. **原文小节被删除**：识别不出。候选池里没有 dialogue 小节可接，正文哈希也查不到以整节哈希为键的旧状态表 → 仍可能被召回。需要 status.mjs / consolidate 增加「正文哈希 → 状态」索引，或写入时带 `sourceId`。
3. **标题改动 + 行号漂移**：本方案只保住正文哈希匹配，仍接不回旧状态键。新标题算出新整节哈希，新行号也不在表里，`resolveEntryStatus` 返回 null；红队缺陷 #2 仍未解决，需要 consolidate/status 用正文哈希建状态索引（或迁移旧表）。
4. **一段正文被多个小节包含**：取正文最短的那个，仍有误接风险（可能接到另一个含同一句话的小节）。没有唯一约束或坐标时不保证正确。
5. **脱敏改变文本**：`sanitize` 把密钥替换后，`bodyId` 与原文正文不同，包含匹配可能失败；安全优先，接受不接。
6. **旧捕获记录**：只有文本逐字是原文子串时能接；否则同第 1 条。
7. **index.js 未接入时**：落盘字段本身不拦截任何东西；4.1 第 5 条会打印泄漏路径。这是预期，本文件就是集成说明。

## 6. 回滚

- 回滚 index.js 的一行调用 + 还原 autocapture.mjs；新增字段对旧读取端无害（index.js 不读就忽略）。
- 已落盘的 `contentId/bodyId/sourceId` 不用删，不影响旧代码。
