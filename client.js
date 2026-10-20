/**
 * dsh-memory-core 的客户端半边：在 DSH 设置页左侧加一节「记忆核心」。
 *
 * 位置：slot `settings.section`（跟 dsh-speak-up / 刷B站 / dshmarket 用的是同一处），
 *       label 就是左侧导航里那一项；section 里只有这一张参数表。
 *
 * ⚠ 这一页**不自己算召回**，只往宿主那两条路由读写：
 *     GET  /dsh-memory-core/config        → { config, fields, groups, editable }
 *     POST /dsh-memory-core/config/save   → 校验后经 ctx.configEditor.edit 落进 profile patch
 *   参数表（默认值 / 范围 / 中文标签）由宿主 config.mjs 给，这里不重复定义一份：
 *   以后加参数只改 config.mjs，面板自己会长出来。
 *
 * ⚠ 没有用 ctx.locale：DSH 这版第三方面板都是直接写中文（speak-up / 刷B站 同款）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-core',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-memory-core'
    const load = () =>
      fetch(BASE + '/config', { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const save = (config) =>
      fetch(BASE + '/config/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      })
        .then((r) => r.json())
        .catch(() => null)

    // 样式全贴主题变量：换深浅色 / 换皮肤都跟着变，不写死颜色（报错的红例外）
    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      title: { fontSize: 15, fontWeight: 600, margin: '2px 0 4px' },
      dim: { opacity: 0.62, fontSize: 12 },
      groupTitle: { fontSize: 13.5, fontWeight: 600, margin: '18px 0 2px' },
      groupHint: { opacity: 0.6, fontSize: 11.5, marginBottom: 8 },
      row: {
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '7px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))',
      },
      lab: { flex: '0 0 210px', minWidth: 160, paddingTop: 2 },
      labText: { fontSize: 12.5 },
      key: { opacity: 0.45, fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace' },
      ctl: { flex: '1 1 260px', minWidth: 200 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 3 },
      err: { color: '#c0392b', fontSize: 11.5, marginTop: 3 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      num: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 120,
        boxSizing: 'border-box',
      },
      numBad: {
        border: '1px solid #c0392b',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 120,
        boxSizing: 'border-box',
      },
      unit: { marginLeft: 6, opacity: 0.6, fontSize: 11.5 },
      sw: (on) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        border: '1px solid ' + (on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
        borderRadius: 999,
        padding: '2px 12px 2px 4px',
        background: on ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
        color: on ? '#fff' : 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1.6,
      }),
      knob: (on) => ({
        display: 'inline-block',
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: on ? '#fff' : 'var(--dsw-alias-border-l2)',
        opacity: on ? 1 : 0.75,
      }),
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      bar: {
        position: 'sticky',
        bottom: 0,
        marginTop: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.95))',
        boxShadow: '0 -6px 18px rgba(0,0,0,.18)',
        zIndex: 5,
      },
      note: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '6px 10px',
        marginTop: 10,
        fontSize: 11.5,
        opacity: 0.8,
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      bad: { color: '#c0392b', fontSize: 12 },
    }

    /** 数字字段在草稿里存字符串：直接存 number 的话，打到「0.」这一步就被吞掉了。 */
    const draftOf = (config) => {
      const d = {}
      for (const key of Object.keys(config || {})) {
        d[key] = typeof config[key] === 'number' ? String(config[key]) : config[key]
      }
      return d
    }

    /** 单个字段的前端校验（宿主那边还会再校验一遍，这里只为当场给提示）。 */
    const checkField = (field, raw) => {
      if (field.type === 'boolean') return typeof raw === 'boolean' ? null : '只能是开或关'
      if (field.type === 'string') return String(raw == null ? '' : raw).trim() === '' ? '不能留空' : null
      const text = String(raw == null ? '' : raw).trim()
      if (text === '') return '要填数字'
      const n = Number(text)
      if (!Number.isFinite(n)) return '要填数字'
      if (n < field.min || n > field.max) return '要在 ' + field.min + '–' + field.max + ' 之间'
      return null
    }

    const rangeHint = (field) => {
      if (field.type === 'boolean') return ''
      if (field.type === 'string') return '默认 ' + field.default
      const unit = field.unit ? ' ' + field.unit : ''
      return '默认 ' + field.default + unit + '，范围 ' + field.min + '–' + field.max + unit
    }

    function Switch(props) {
      const on = !!props.checked
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          style: S.sw(on),
          onClick: () => props.onChange(!on),
        },
        h('span', { style: S.knob(on), 'aria-hidden': 'true' }),
        h('span', null, on ? '开' : '关'),
      )
    }

    function Field(props) {
      const field = props.field
      const error = props.error
      let control
      if (field.type === 'boolean') {
        control = h(Switch, { checked: props.value === true, onChange: props.onChange })
      } else if (field.type === 'number') {
        control = h('input', {
          type: 'number',
          value: props.value == null ? '' : String(props.value),
          min: field.min,
          max: field.max,
          step: field.step,
          style: error ? S.numBad : S.num,
          onChange: (event) => props.onChange(event.target.value),
        })
        if (field.unit) control = h('span', null, control, h('span', { style: S.unit }, field.unit))
      } else {
        control = h('input', {
          type: 'text',
          value: props.value == null ? '' : String(props.value),
          style: S.input,
          spellCheck: false,
          onChange: (event) => props.onChange(event.target.value),
        })
      }

      const hintText = [field.hint, rangeHint(field)].filter(Boolean).join('　')

      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.lab },
          h('div', { style: S.labText }, field.label),
          h('div', { style: S.key }, field.key),
        ),
        h(
          'div',
          { style: S.ctl },
          control,
          hintText ? h('div', { style: S.hint }, hintText) : null,
          error ? h('div', { style: S.err }, error) : null,
        ),
      )
    }

    function Section() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [errors, setErrors] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null) // { kind: 'ok' | 'bad', text }
      const [dead, setDead] = React.useState('')

      const pull = React.useCallback(() => {
        load().then((data) => {
          if (!data || data.ok !== true) {
            setDead('读不到宿主那边（插件加载了吗？设置面板要宿主半边活着才能读写）。')
            return
          }
          setDead('')
          setState(data)
          setDraft(draftOf(data.config))
        })
      }, [])

      React.useEffect(() => {
        pull()
      }, [pull])

      if (dead) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, '记忆核心'),
          h('div', { style: S.bad }, dead),
        )
      }

      if (!state || !draft) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, '记忆核心'),
          h('div', { style: S.dim }, '读取中…'),
        )
      }

      const fields = Array.isArray(state.fields) ? state.fields : []
      const groups = Array.isArray(state.groups) ? state.groups : []
      const config = state.config || {}

      const dirty = fields.some((f) => String(draft[f.key]) !== String(config[f.key]))
      const change = (key, value) => {
        setDraft((old) => ({ ...old, [key]: value }))
        setErrors((old) => (old[key] ? { ...old, [key]: undefined } : old))
        setMsg(null)
      }
      const reset = () => {
        setDraft(draftOf(config))
        setErrors({})
        setMsg(null)
      }

      const submit = () => {
        const nextErrors = {}
        const payload = {}
        for (const f of fields) {
          const problem = checkField(f, draft[f.key])
          if (problem) {
            nextErrors[f.key] = problem
            continue
          }
          if (f.type === 'number') payload[f.key] = Number(String(draft[f.key]).trim())
          else payload[f.key] = draft[f.key]
        }
        setErrors(nextErrors)
        if (Object.keys(nextErrors).length > 0) {
          setMsg({ kind: 'bad', text: '有参数不合规矩，先按提示改一改。' })
          return
        }

        setBusy(true)
        setMsg(null)
        save(payload).then((data) => {
          setBusy(false)
          if (!data) {
            setMsg({ kind: 'bad', text: '保存请求没送到宿主（页面还连着吗？）' })
            return
          }
          if (data.config) {
            setState((old) => ({ ...old, config: data.config }))
            setDraft(draftOf(data.config))
          }
          if (data.errors && Object.keys(data.errors).length > 0) setErrors(data.errors)
          if (data.ok === true) {
            setErrors({})
            setMsg({ kind: 'ok', text: '已保存进 profile 配置，重启之后还是这些值。' })
          } else {
            setMsg({ kind: 'bad', text: String(data.message || '保存没成功') })
          }
        })
      }

      // 宿主没给分组时（老版本）就退化成一大组，别把字段全吞了
      const groupList = groups.length > 0 ? groups : [{ id: null, label: '' }]
      const byGroup = (id) => (id === null ? fields : fields.filter((f) => f.group === id))

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.title }, '记忆核心'),
        h(
          'div',
          { style: S.dim },
          '召回条数、命中门槛、权重衰减、自动捕获都在这调。改动先点保存，没保存的改动不算数。',
        ),

        groupList.map((group) => {
          const list = byGroup(group.id)
          if (list.length === 0) return null
          return h(
            'div',
            { key: group.id || 'all' },
            h('div', { style: S.groupTitle }, group.label),
            group.hint ? h('div', { style: S.groupHint }, group.hint) : null,
            list.map((f) =>
              h(Field, {
                key: f.key,
                field: f,
                value: draft[f.key],
                error: errors[f.key],
                onChange: (value) => change(f.key, value),
              }),
            ),
          )
        }),

        state.editable === false
          ? h(
              'div',
              { style: S.note },
              '这个部署没有 configEditor：改了当场生效，但存不进 profile 配置，重启会回到旧值。',
            )
          : null,

        h(
          'div',
          { style: S.bar },
          h(
            'button',
            { type: 'button', style: dirty && !busy ? S.btnOn : S.btn, disabled: !dirty || busy, onClick: submit },
            busy ? '保存中…' : '保存',
          ),
          h('button', { type: 'button', style: S.btn, disabled: !dirty || busy, onClick: reset }, '撤销改动'),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: pull }, '重新读取'),
          msg ? h('span', { style: msg.kind === 'ok' ? S.ok : S.bad }, msg.text) : null,
          !msg && dirty ? h('span', { style: S.dim }, '有改动还没保存') : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      // slot 契约只认 id / order / label（没有 icon 字段），label 就是左侧导航那一项。
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'memory-core', order: 58, label: '记忆核心' }, Section),
      )
    }

    return { inject: ['slots'], apply }
  },
})
