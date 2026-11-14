// Verifies the composer add-menu entry. The host calls `available(session)` and
// `label()` while synthesising the `/` candidate list, and a throw from either
// one aborts synthesis and leaves the add button looking dead — so this script
// replays the host's own loop over the real contribution.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const REPO = fileURLToPath(new URL('..', import.meta.url))
const say = (...a) => process.stdout.write(a.join(' ') + '\n')
let failures = 0
const check = (l, ok, extra = '') => { if (ok) say('ok   ' + l); else { failures += 1; say('FAIL ' + l + '  ' + extra) } }

const FILE = `${REPO}/client.js`
const src = fs.readFileSync(FILE, 'utf8')

// --- load the module behind the client loader -------------------------------
const dictOf = (name) => {
  const i = src.indexOf('const ' + name + ' = {')
  const j = src.indexOf('\n    }', i)
  const out = {}
  for (const m of src.slice(i, j).matchAll(/'?([A-Za-z][A-Za-z0-9._]*)'?:\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2].replace(/\\'/g, "'")
  return out
}
const zh = dictOf('zh'); const en = dictOf('en')

const slots = []; let cursor = 0; const effects = []
const react = {
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
}
let captured = null
globalThis.window = { __ModuleLoader__: { load(s) { captured = s } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
globalThis.document = { addEventListener() {}, removeEventListener() {}, body: {} }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
new Function(src)()
const instance = captured.factory((n) => {
  if (n === 'react') return react
  if (n === 'react-dom') return { createPortal: (el) => el }
  throw new Error('require ' + n)
})

// --- capture the contribution ----------------------------------------------
let contribution = null
let injects = null
instance.apply({
  effect(fn) { const d = fn(); return d ?? (() => {}) },
  locale: { register: () => () => {}, bind: () => (k) => zh[k] ?? k }, on() {},
  slots: {
    inject(k, cb) { cb(); return () => {} },
    register: (o, c) => ({ options: o, component: c }),
  },
  commandUi: { register(c) { contribution = c; return () => {} } },
  sessions: { binding: () => bindingImpl() },
  remote: {
    $on: () => () => {},
    permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
    directoryPicker: { pick: async () => ({ ok: true, value: null }) },
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: 'x' } } }) },
  },
})

check('the add-menu contribution registers', contribution !== null)
check('the contribution exposes ui.kind === "action"', contribution?.ui?.kind === 'action')

// --- the host's candidate synthesis, replayed -------------------------------
// Mirrors dsh-client-ui-commands/lib/client.js:1535-1552: host rows are entered
// into `seen` first, then each contribution must pass `available` and must not
// repeat a name in `seen`.
const HOST_COMMANDS = ['permission', 'plan', 'feedback', 'compact', 'export', 'goal', 'access-allow']
const synthesize = (session) => {
  const seen = new Set(HOST_COMMANDS)
  const rows = []
  if (!contribution.available(session)) return { rows, skipped: true }
  if (seen.has(contribution.name)) throw new Error(`ui-commands: contribution /${contribution.name} collides with a host command`)
  rows.push({
    name: contribution.name,
    label: contribution.label === undefined ? contribution.name : contribution.label(),
    detail: contribution.description === undefined ? undefined : contribution.description(),
  })
  return { rows, skipped: false }
}

// The plugin reads the level through `ctx.sessions.binding(id)`, so each case
// swaps the stub's binding implementation.
let bindingImpl = () => undefined
const project = (value) => () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => value }) } } })
const cases = [
  ['not bound yet (binding -> undefined)', () => undefined, false],
  ['binding present, session missing', () => ({}), false],
  ['session present, projections missing', () => ({ session: {} }), false],
  ['faceOf throws', () => ({ session: { projections: { faceOf: () => { throw new Error('boom') } } } }), false],
  ['snapshot undefined', project(undefined), false],
  ['snapshot without currentValue', project({}), false],
  ['danger-full-access', project({ currentValue: 'danger-full-access' }), false],
  ['workspace-write', project({ currentValue: 'workspace-write' }), true],
  ['read-only', project({ currentValue: 'read-only' }), true],
  ['no-access', project({ currentValue: 'no-access' }), true],
  ['workspace-access', project({ currentValue: 'workspace-access' }), true],
  // An unrecognised preset must read as restricted, never as full access.
  ['unknown preset', project({ currentValue: 'mystery-mode' }), true],
  ['poisoned session', () => { throw new Error('poisoned') }, false],
]
const session = { sessionId: 's1' }
for (const [label, impl, want] of cases) {
  bindingImpl = impl
  let outcome = null
  let threw = null
  try { outcome = synthesize(session) } catch (cause) { threw = cause }
  check(`menu survives: ${label}`, threw === null, `threw ${threw && threw.message}`)
  if (threw === null) check(`  listed = ${want}: ${label}`, outcome.skipped === !want, `skipped=${outcome.skipped}`)
}

// The menu must actually offer the row under a restricted level, with Chinese text.
{
  bindingImpl = project({ currentValue: 'workspace-access' })
  const { rows } = synthesize(session)
  check('restricted level offers exactly one row', rows.length === 1)
  check('row label is the Chinese name', rows[0]?.label === '额外可读文件', JSON.stringify(rows[0]?.label))
  check('row name is ASCII (no host collision surface)', /^[\x20-\x7e]+$/.test(contribution.name), contribution.name)
  check('row name is not a host command', !HOST_COMMANDS.includes(contribution.name), contribution.name)
}

// --- no dict key may be missing ---------------------------------------------
// Both spellings matter: a `t('k')` scan alone misses `ctx.locale.bind(NS)('k')`,
// which is how the menu row's label went missing.
const used = new Set()
for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_.])t\('([A-Za-z][A-Za-z0-9_.]*)'\)/g)) used.add(m[1])
for (const m of src.matchAll(/bind\(NS\)\('([A-Za-z][A-Za-z0-9_.]*)'\)/g)) used.add(m[1])
for (const m of src.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_.]*)'/g)) used.add(m[1])
const missingZh = [...used].filter((k) => !(k in zh))
const missingEn = [...used].filter((k) => !(k in en))
check(`every referenced key exists in zh (scanned ${used.size})`, missingZh.length === 0, missingZh.join(','))
check('every referenced key exists in en', missingEn.length === 0, missingEn.join(','))
check('zh and en define the same key set', JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
  `zh-only=${Object.keys(zh).filter((k) => !(k in en))} en-only=${Object.keys(en).filter((k) => !(k in zh))}`)
check("the row description is real text, not a key name", zh.addAllowedHint !== undefined && zh.addAllowedHint !== 'addAllowedHint', zh.addAllowedHint)

say(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
