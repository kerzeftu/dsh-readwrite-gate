// Seat-takeover regression check.
//
// Why this file exists: `check-panel.mjs` stubs `slots.register` with a
// permissive `(options, component) => ({ options, component })`, so it can
// never notice that the real slot core REJECTS a second registration at the
// same priority. That is exactly how the shipped permission control kept the
// `conversation.input.permission` seat: my registration at the default
// priority 0 collided with the shipped registration (also priority 0), the
// throw tore the inject down, and the composer kept a control whose glyph
// table has no icon for our two added presets.
//
// This check replays the real rules from
// `@deepseek-ai/dsh-client-ui-slots/lib/index.js:163-243` (single seat: same
// priority throws; lowest priority renders) and from
// `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1391-1400` (a setup
// failure throws out of `slots.inject` when the seat is already declared, and
// is caught + rethrown asynchronously when it is declared later).
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const say = (...a) => process.stdout.write(a.join(' ') + '\n')
let failures = 0
const check = (l, ok, extra = '') => { if (ok) say('ok   ' + l); else { failures += 1; say('FAIL ' + l + '  ' + extra) } }

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = process.env.AP_CLIENT ?? `${REPO}/client.js`
/** A DSH checkout to compare the seat contract against; optional. */
const DSH = process.env.AP_DSH_DIR ?? join(homedir(), '.dsh-versions', '0.2.1-alpha.1')
const HOST_PRESETS = join(DSH, 'node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js')
const src = fs.readFileSync(PLUGIN, 'utf8')

/* ------------------------------------------------------------------ *
 * A reduced but faithful slot core.                                   *
 * ------------------------------------------------------------------ */
const makeCore = () => {
  const records = new Map() // name -> { spec, entries }
  const waiting = new Map() // name -> Set<listener>
  const failures = []       // deferred setup failures (the async path)
  const declareOnly = (name, spec) => { records.set(name, { spec, entries: [] }) }
  const fire = (name) => {
    for (const fn of [...(waiting.get(name) ?? [])]) fn()
    waiting.delete(name)
  }
  const declare = (name, spec) => { declareOnly(name, spec); fire(name) }
  const register = (options, component) => {
    const rec = records.get(options.name)
    if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    const priority = options.priority ?? 0
    if (rec.spec.kind === 'single') {
      const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority)
      if (occupant) throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}${occupant.registrant === undefined ? '' : ` (registered by ${occupant.registrant})`} — register at a different priority to shadow it (lowest renders)`)
    }
    if (rec.spec.kind === 'list') {
      if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
      const occupant = rec.entries.find((e) => e.options.id === options.id && (e.options.priority ?? 0) === priority)
      if (occupant) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}" at priority ${priority}`)
    }
    const entry = { options, component, registrant: options.registrant }
    rec.entries = [...rec.entries, entry]
    return () => { rec.entries = rec.entries.filter((e) => e !== entry) }
  }
  // Shadowing projection: one cell per seat (single) / per id (list); the first
  // live entry in ascending priority order wins.
  const winners = (name) => {
    const rec = records.get(name)
    if (rec === undefined) return []
    const cells = new Map()
    const sorted = [...rec.entries].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    for (const entry of sorted) {
      const cell = rec.spec.kind === 'single' ? '' : rec.spec.kind === 'list' ? (entry.options.id ?? '') : (entry.options.key ?? '')
      if (!cells.has(cell)) cells.set(cell, entry)
    }
    return [...cells.values()]
  }
  const inject = (key, callback) => {
    if (records.get(key)?.spec !== undefined) {
      // Already declared: the renderer reconciles synchronously and rethrows.
      callback()
      return () => {}
    }
    const listener = () => {
      // Declared later: the renderer catches, tears the inject down, and
      // rethrows the failure asynchronously — the plugin half keeps loading.
      try { callback() } catch (error) { failures.push(error) }
    }
    if (!waiting.has(key)) waiting.set(key, new Set())
    waiting.get(key).add(listener)
    return () => waiting.get(key)?.delete(listener)
  }
  return { records, failures, declare, declareOnly, fire, register, winners, inject }
}

/* ------------------------------------------------------------------ *
 * Load one fresh copy of the client half against a given core.        *
 * ------------------------------------------------------------------ */
let captured = null
globalThis.window = { __ModuleLoader__: { load(s) { captured = s } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
globalThis.document = { addEventListener() {}, removeEventListener() {}, body: {} }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

const load = (core) => {
  const commandRows = []
  captured = null
  new Function(src)()
  const instance = captured.factory((n) => {
    if (n === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...(p ?? {}), children: c.length <= 1 ? c[0] : c } }), useState: (i) => [i, () => {}], useEffect() {}, useRef: (i) => ({ current: i }) }
    if (n === 'react-dom') return { createPortal: (el) => el }
    throw new Error('require ' + n)
  })
  const ctx = {
    effect(fn) { const d = fn(); return d ?? (() => {}) },
    locale: { register: () => () => {}, bind: () => (k) => k }, on() {},
    slots: { inject: (k, cb) => core.inject(k, () => cb()), register: (o, c) => core.register(o, c) },
    commandUi: { register(row) { commandRows.push(row); return () => {} } },
    sessions: { binding: () => undefined },
    remote: { $on: () => () => {}, permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
      directoryPicker: { pick: async () => ({ ok: true, value: null }) },
      commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '' } } }) } },
  }
  let thrown = null
  try { instance.apply(ctx) } catch (error) { thrown = error }
  return { thrown, commandRows }
}

const seats = (core) => {
  core.declare('conversation.input.permission', { kind: 'single', scope: 'session' })
  core.declare('conversation.input.right', { kind: 'list', scope: 'session' })
}
const shipped = { label: 'shipped PermissionSelect' }
const isMine = (entry) => entry.component !== shipped && typeof entry.component === 'function'

/* ---- scenario 1: the shipped control is already sitting on the seat ---- */
{
  const core = makeCore()
  seats(core)
  core.register({ name: 'conversation.input.permission', registrant: 'gf' }, shipped)
  const { thrown, commandRows } = load(core)
  check('1. plugin loads with the shipped control already on the seat', thrown === null, String(thrown))
  check('1. no deferred seat-takeover failure', core.failures.length === 0, core.failures.map((e) => e.message).join(' | '))
  check('1. the plugin claims the permission seat', core.records.get('conversation.input.permission').entries.some(isMine))
  const claim = core.records.get('conversation.input.permission').entries.find(isMine)
  check('1. the claim uses a priority below the shipped 0', claim !== undefined && (claim.options.priority ?? 0) < 0, JSON.stringify(claim?.options.priority))
  check('1. the plugin wins the shadowing race (lowest renders)', isMine(core.winners('conversation.input.permission')[0] ?? {}))
  check('1. the readable-files cell still registers', core.winners('conversation.input.right').some((e) => e.options.id === 'readwrite-gate-files'))
  check('1. the add-menu row still registers', commandRows.some((r) => r.name === 'extra-readable-files'))
}

/* ---- scenario 2: the seats are declared only after the plugin loads ---- *
 * This is the ordering the live browser actually had: the plugin half loads
 * first, so its `inject` defers; the composer bar declares the seats later,
 * and the shipped control takes priority 0 before the deferred claim runs. */
{
  const core = makeCore()
  const { thrown, commandRows } = load(core)
  check('2. plugin loads before the seats exist', thrown === null, String(thrown))
  core.declareOnly('conversation.input.permission', { kind: 'single', scope: 'session' })
  core.declareOnly('conversation.input.right', { kind: 'list', scope: 'session' })
  core.register({ name: 'conversation.input.permission', registrant: 'gf' }, shipped)
  core.fire('conversation.input.permission')
  core.fire('conversation.input.right')
  check('2. no deferred seat-takeover failure', core.failures.length === 0, core.failures.map((e) => e.message).join(' | '))
  check('2. the claim survived the late declaration', core.records.get('conversation.input.permission').entries.some(isMine))
  check('2. the plugin wins the shadowing race (lowest renders)', isMine(core.winners('conversation.input.permission')[0] ?? {}))
  check('2. the readable-files cell registers too', core.winners('conversation.input.right').some((e) => e.options.id === 'readwrite-gate-files'))
  check('2. the add-menu row registers too', commandRows.some((r) => r.name === 'extra-readable-files'))
}

/* ---- scenario 3: declaration order flipped (shipped registers last) ---- */
{
  const core = makeCore()
  seats(core)
  core.register({ name: 'conversation.input.permission', registrant: 'gf' }, shipped)
  const { thrown } = load(core)
  // The shipped control re-registers after a declaration epoch change.
  core.register({ name: 'conversation.input.permission', registrant: 'gf', priority: 1 }, shipped)
  check('3. a late re-registration cannot displace the claim', thrown === null && isMine(core.winners('conversation.input.permission')[0] ?? {}))
}

/* ---- the host contract this fix depends on ---- */
if (!fs.existsSync(HOST_PRESETS)) {
  say('skip host preset contract (no DSH checkout at ' + DSH + ')')
} else {
  const host = fs.readFileSync(HOST_PRESETS, 'utf8')
  const from = host.indexOf('const permissionGlyphs = new Map([')
  const table = host.slice(from, host.indexOf(']);', from) + 2)
  check('host glyph table is hard-coded to exactly the 3 shipped presets', (table.match(/PermissionIcon\w+/g) ?? []).length === 3, table.slice(0, 120))
  check('host glyph table has no entry for our two added presets', table !== '' && !table.includes('workspace-access') && !table.includes('no-access'))
  check('host documents that names outside the design set get none', host.includes('host-configured names outside the design set get none'))
  const registration = host.slice(host.indexOf('conversation.input.permission"'), host.indexOf('PermissionSelect)'))
  check('the shipped registration passes no priority (so it is priority 0)', !/priority\s*:/.test(registration))
  check('our registration passes an explicit negative priority', /name: 'conversation\.input\.permission',\s*\n\s*priority: -1,/.test(src))
}

/* ---- the contract we rely on is the one the host actually implements ---- */
{
  const coreFile = join(DSH, 'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js')
  if (!fs.existsSync(coreFile)) {
    say('skip host core contract (no DSH checkout at ' + DSH + ')')
  } else {
  const coreLib = fs.readFileSync(coreFile, 'utf8')
  check('host core rejects a same-priority single-seat registration', /case "single": \{[\s\S]{0,260}already has a registration/.test(coreLib))
  check('host core renders the lowest priority', /lowest renders/.test(coreLib) && /\(a, b\) => \(a\.options\.priority \?\? 0\) - \(b\.options\.priority \?\? 0\)/.test(coreLib))
  }
}

say('')
say(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
