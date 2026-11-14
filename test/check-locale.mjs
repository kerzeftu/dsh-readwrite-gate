import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const REPO = fileURLToPath(new URL('..', import.meta.url))
const say = (...a) => process.stdout.write(a.join(' ') + '\n')
let failures = 0
const check = (l, ok, extra = '') => { if (ok) say('ok   ' + l); else { failures += 1; say('FAIL ' + l + '  ' + extra) } }

const src = fs.readFileSync(process.env.AP_CLIENT ?? `${REPO}/client.js`, 'utf8')
const slice = (name) => { const i = src.indexOf('const ' + name + ' = {'); const j = src.indexOf('\n    }', i); return src.slice(i, j) }
const dictOf = (name) => {
  const body = slice(name).replace(/^\s*const \w+ = \{/, '')
  const out = {}
  for (const m of body.matchAll(/'?([A-Za-z][A-Za-z0-9._]*)'?:\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2].replace(/\\'/g, "'")
  return out
}
const zh = dictOf('zh'), en = dictOf('en')
check('the workspace level copy names the read-and-write level', zh['workspace.label'] === '工作区内读写', String(zh['workspace.label']))
check('the English copy names the read-and-write level', en['workspace.label'] === 'Read and write inside workspace', String(en['workspace.label']))
const used = [...new Set([...src.matchAll(/\.t\('([^']+)'\)/g)].map((m) => m[1]))].sort()

// The locale service resolves as: my namespace -> `common` -> the key itself.
// So the contract is that no key may survive to its own literal name.
const literal = used.filter((k) => !(k in zh) || !(k in en))
check(`every one of the ${used.length} used keys resolves in zh and en`, literal.length === 0, literal.join(', '))
check('the two dictionaries have identical key sets',
  JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()))

// The full-access gate is the one surface a user compares against the shipped
// Host dialog, so its wording follows the 0.2.1 access-gate strings word for
// word (only the level's own name differs).
check('the full-access gate reuses the host title', zh.confirmTitle === '确认启用完全访问？', String(zh.confirmTitle))
check('the full-access gate reuses the host acknowledgement', zh.confirmAcknowledge === '我已了解风险，并愿意继续', String(zh.confirmAcknowledge))
check('the full-access gate reuses the host primary label', zh.confirmEnable === '启用完全访问', String(zh.confirmEnable))
check('the full-access gate reuses the host warning body',
  zh.confirmDescription === '启用完全访问后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
  String(zh.confirmDescription))
check('the English gate mirrors the host title', en.confirmTitle === 'Enable Full access?', String(en.confirmTitle))
check('the English gate mirrors the host acknowledgement', en.confirmAcknowledge === 'I understand the risks and want to continue', String(en.confirmAcknowledge))

// Render the seat: the label the user sees must be the Chinese one.
function makeReact() {
  const slots = []; let cursor = 0; const effects = []
  return {
    api: {
      createElement(type, props, ...children) {
        const flat = (l) => l.flatMap((c) => (Array.isArray(c) ? flat(c) : [c]))
        const kids = flat(children).filter((c) => c !== null && c !== undefined && c !== false)
        const value = (children.length === 1 && Array.isArray(children[0])) ? children[0].flat() : (children.length <= 1 ? kids[0] : kids)
        if (typeof type === 'function') return type({ ...(props ?? {}), children: value })
        return { type, props: { ...(props ?? {}), children: value } }
      },
      useState(i) { const n = cursor++; if (!(n in slots)) slots[n] = typeof i === 'function' ? i() : i; return [slots[n], (v) => { slots[n] = typeof v === 'function' ? v(slots[n]) : v }] },
      useEffect(f) { effects.push(f) },
      useRef(i) { const n = cursor++; if (!(n in slots)) slots[n] = { current: i }; return slots[n] },
    },
    reset() { cursor = 0 }, runEffects() { for (const f of effects.splice(0)) f() },
  }
}
const react = makeReact()
let captured = null
globalThis.window = { __ModuleLoader__: { load(s) { captured = s } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
globalThis.document = { addEventListener() {}, removeEventListener() {}, body: {} }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
new Function(src)()
const instance = captured.factory((n) => {
  if (n === 'react') return react.api
  if (n === 'react-dom') return { createPortal: (el) => el }
  throw new Error('require ' + n)
})
const regs = []
instance.apply({
  effect(fn) { const d = fn(); return d ?? (() => {}) },
  // The real service falls back to the key itself, which is what made the bug visible.
  locale: { register: () => () => {}, bind: (ns) => (k) => zh[k] ?? k }, on() {},
  slots: { inject(k, cb) { regs.push({ key: k, ...cb() }); return () => {} }, register: (o, c) => ({ options: o, component: c }) },
  commandUi: { register() { return () => {} } },
  sessions: { binding: () => undefined },
  remote: { $on: () => () => {}, permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
    directoryPicker: { pick: async () => ({ ok: true, value: null }) },
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '' } } }) } },
})
const seat = regs.find((r) => r.key === 'conversation.input.permission')
const injected = seat.options.inject('s1')
const catalog = { options: [
  { value: 'no-access', name: '无权限' },
  { value: 'workspace-access', name: '工作区内读写' },
  { value: 'read-only', name: '只读' },
  { value: 'workspace-write', name: '工作区内编辑' },
  { value: 'danger-full-access', name: '完全访问' },
] }
const texts = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  const kids = node.props?.children
  for (const c of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) texts(c, out)
  return out
}
const fileSeat = regs.find((r) => r.key === 'conversation.input.right')
check('the readable-files seat is registered', fileSeat !== undefined)
const fileInjected = fileSeat.options.inject('s1')
for (const preset of ['workspace-access', 'danger-full-access']) {
  react.reset()
  const tree = fileSeat.component({ sessionId: 's1', locked: false, t: (k) => zh[k] ?? k, useProjection: () => ({ currentValue: preset }), usePermissionCatalog: (sel) => sel(catalog), ...fileInjected })
  react.runEffects()
  const shown = texts(tree)
  const label = shown.find((s) => s.includes('额外可读')) ?? null
  const wanted = '额外可读写文件'
  check(`${preset}: the button is labelled in Chinese`, label === wanted, `${JSON.stringify(label)} vs ${JSON.stringify(wanted)} :: ${JSON.stringify(shown)}`)
  check(`${preset}: no raw key survives in the rendered text`, !shown.some((s) => /^(allow|enter|pick|remove)[A-Z]/.test(s)), JSON.stringify(shown))
  say('       button text: ' + JSON.stringify(shown))
}
say('')
for (const locale of ['zh', 'en']) {
  const dict = locale === 'zh' ? zh : en
  say(`  ${locale}  allowEntry = ${JSON.stringify(dict.allowEntry)}  |  hint = ${JSON.stringify(dict.allowHint.slice(0, 28))}…`)
}
say(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)
