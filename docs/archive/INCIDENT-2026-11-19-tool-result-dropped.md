# 事故复盘：post-execute 钩子吞掉全部工具结果（2026-11-19）

一句话：**钩子签名少写一个参数，导致所有工具结果变成 `undefined`，整台 DSH 的工具链全断。**

## 现象

调用任意工具（哪怕只是读两行文件）都立刻失败：

```
Cannot read properties of undefined (reading 'additionalContexts')
```

界面表现是窗口"卡死"：工具结果永远回不去，前端一直转圈。跟工具本身无关——读文件、grep、跑 shell 全都炸在同一条报错上。

## 根因

`index.js` 里注册 `tools/post-execute` 的写法：

```js
// 改前（错误）
ctx.on('tools/post-execute',
  async (payload, next) => {                       // 少声明一个参数
    const out = typeof next === 'function' ? await next() : undefined
    ...
    return out
  }, { prepend: true })
```

DSH 的 `tools/post-execute` 协议是 `(exec, result, next)`：

- `payload` 拿到的是 exec（正常）
- `next` 位置拿到的其实是 **result 对象**，不是函数
- 因此 `typeof next === 'function'` 恒为 `false`，下游钩子**从不被调用**
- 函数直接 `return undefined`，工具结果被吞成空

它是 `{ prepend: true }`，排在整条水线最前面，于是**任何工具执行完结果都是 undefined**；后面 `cc-safety-net` 的钩子读 `result.additionalContexts` 时踩空抛错，整条工具链断掉。

引入提交：`83bbb7e feat: content-fingerprint dedup + tool activity tracking`。

## 修法

```js
// 改后（正确）
async (payload, result, next) => {
  const out = typeof next === 'function' ? await next() : result
  ...
  return out
}
```

两处改动缺一不可：**声明第三个参数**，以及**兜底从 `undefined` 换成 `result`**。只改前者的话，一旦下游没接上照样吞结果。

`agent/pre-step` 用的是 `async (payload, next)`，那个事件本来就是双参数，签名正确，不要动。

## 排查弯路（记下来免得再走）

| 猜测 | 证据 | 结论 |
|---|---|---|
| `dsh-ops` 新旧模块重复注册 | 禁用 `dsh-ops/shell` + `dsh-ops/file` 后清单一度瘦身，但工具照炸 | 排除 |
| IM / 群聊插件往结果里贴上下文 | `additionalContexts` 名字像它干的 | 排除 |
| 插件清单太长 | 换 `safe` 档瘦清单时工具正常 | **关键线索，但方向反了**——瘦清单里没有 memory-core |

真正有用的那条证据是：**瘦清单（没装 memory-core）时一切都好，把它加回来就全炸**。

## 验证

1. `read` 读 `AGENTS.md` 全文 108 行 → 正常返回
2. `grep` 搜源码 → 正常返回
3. 配置恢复后再验一次，两个工具仍然正常

## 教训

1. **prepend 钩子的返回值就是全链路的输入。** 它一旦返回 `undefined`，后面所有钩子都在处理一个空对象，报错位置会跑偏到无辜的插件上。
2. **不要用 `typeof x === 'function'` 去猜参数位置。** 这种写法把"签名写错了"伪装成"下游没接"，静默失败、零日志，排查时全靠二分。
3. **钩子包装必须原样透传**：`return next ? await next() : result`，任何情况下都不能 `return undefined`。
4. 现象与现场对不上时，先找"哪个环境是好的"（这次是 safe 档瘦清单），再比对两边差异，比逐个摘插件快得多。
