/**
 * Visual-consistency check for the two composer controls.
 *
 * The two seats must read as one control family: identical geometry, one
 * symbol each, and colour as the only per-level difference. This renders both
 * seats through a stub React and inspects the styles and the rendered leaves.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const REPO = fileURLToPath(new URL('..', import.meta.url))

const say = (...a) => process.stdout.write(a.join(' ') + '\n')
let failures = 0
const check = (l, ok, extra = '') => { if (ok) say('ok   ' + l); else { failures += 1; say('FAIL ' + l + '  ' + extra) } }

const src = fs.readFileSync(process.env.AP_CLIENT ?? `${REPO}/client.js`, 'utf8')
const dictOf = (name) => {
  const i = src.indexOf('const ' + name + ' = {'); const j = src.indexOf('\n    }', i)
  const out = {}
  for (const m of src.slice(i, j).matchAll(/'?([A-Za-z][A-Za-z0-9._]*)'?:\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2].replace(/\\'/g, "'")
  return out
}
const zh = dictOf('zh')
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
// The plugin publishes its two yellow tokens through a style element (the theme
// has no yellow alias), so the stub records what it appends.
const styleNodes = []
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, body: {},
  querySelector: (selector) => styleNodes.find((node) => node.selector === selector) ?? null,
  head: { appendChild(node) { styleNodes.push(node) } },
  createElement(tag) {
    return {
      tagName: tag, selector: null, textContent: '',
      setAttribute(name, value) { if (name === 'data-plugin-css') this.selector = `style[data-plugin-css="${value}"]` },
    }
  },
}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
new Function(src)()
const instance = captured.factory((n) => {
  if (n === 'react') return react
  if (n === 'react-dom') return { createPortal: (el) => el }
  throw new Error('require ' + n)
})
const regs = []
const ctxStub = {
  effect(fn) { const d = fn(); return d ?? (() => {}) },
  locale: { register: () => () => {}, bind: () => (k) => zh[k] ?? k }, on() {},
  slots: { inject(k, cb) { regs.push({ key: k, ...cb() }); return () => {} }, register: (o, c) => ({ options: o, component: c }) },
  commandUi: { register() { return () => {} } }, sessions: { binding: () => undefined },
  remote: {
    $on: () => () => {},
    permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
    directoryPicker: { pick: async () => ({ ok: true, value: null }) },
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: 'x [allow: %2Ftmp%2Fa]' } } }) },
  },
}
instance.apply(ctxStub)

const permissionSeat = regs.find((r) => r.key === 'conversation.input.permission')
const allowSeat = regs.find((r) => r.key === 'conversation.input.right')
check('both seats are registered', permissionSeat !== undefined && allowSeat !== undefined)

/** Collect every element in a rendered tree. */
const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return out }
  if (typeof node !== 'object' || node.props === undefined) return out
  out.push(node)
  walk(node.props.children, out)
  return out
}
/** Collect every string leaf in a rendered tree. */
const texts = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) texts(c, out); return out }
  if (node !== null && typeof node === 'object' && node.props !== undefined) texts(node.props.children, out)
  return out
}
/** The trigger button of either control. */
const triggerOf = (tree) => walk(tree).find((n) => n.type === 'button' && n.props['aria-haspopup'] !== undefined)
/** The mode-symbol signature of a trigger: tag names plus path data, chevron excluded. */
const symbolOf = (node) => {
  const svgs = walk(node).filter((n) => n.type === 'svg')
  const first = svgs[0]
  if (first === undefined) return null
  return walk(first).map((n) => (n.type === 'path' ? n.props.d : n.type)).join('|')
}
const GEOMETRY = ['display', 'alignItems', 'gap', 'height', 'padding', 'border', 'borderRadius', 'fontSize', 'fontWeight', 'lineHeight']
const geometryOf = (style) => GEOMETRY.map((k) => `${k}=${String(style[k])}`).join(' ')

const MODES = ['no-access', 'workspace-access', 'read-only', 'workspace-write', 'danger-full-access']
const seen = {}
const triggerGeometries = []
const rowColors = []

for (const mode of MODES) {
  slots.length = 0; cursor = 0; effects.length = 0
  const injected = permissionSeat.options.inject('s1')
  const props = {
    sessionId: 's1', locked: false, t: (k) => zh[k] ?? k,
    useProjection: () => ({ currentValue: mode }),
    usePermissionCatalog: () => null,
    ...injected,
  }
  const closed = permissionSeat.component(props)
  const trigger = triggerOf(closed)
  check(`${mode}: renders a trigger button`, trigger !== undefined)
  const style = trigger.props.style
  triggerGeometries.push(geometryOf(style))
  seen[mode] = { accent: style.color, symbol: symbolOf(trigger) }
  check(`${mode}: trigger geometry is the shared one`, style.height === 28 && style.fontSize === 13 && style.fontWeight === 500 && style.gap === 4, JSON.stringify(style))
  check(`${mode}: chevron is a symbol, not a text glyph`, !walk(trigger).some((n) => n.type === 'span' && /[\u25b4\u25be]/.test(String(n.props.children))))
  check(`${mode}: the accent tints both icon and label`, style.color === seen[mode].accent && walk(trigger).filter((n) => n.props.style?.color === style.color).length >= 2)

  // Open the menu: useState #0 of PermissionControl is `open`.
  slots[0] = true; cursor = 0
  const opened = permissionSeat.component(props)
  const rows = walk(opened).filter((n) => n.props.role === 'menuitemradio')
  check(`${mode}: the menu lists every level`, rows.length === MODES.length, `rows=${rows.length}`)
  const colors = rows.map((r) => walk(r).find((n) => typeof n.props?.children === 'string' && n.props.children.length > 0)?.props?.style?.color)
  rowColors.push(colors)
  check(`${mode}: every row carries one symbol`, rows.every((r) => walk(r).some((n) => n.type === 'svg')))
  check(`${mode}: rows carry no raw key names`, rows.every((r) => texts(r).every((s) => !/^[a-zA-Z][A-Za-z0-9.]*$/.test(s))), JSON.stringify(texts(rows[0])))
}

check('the five levels use five different accents', new Set(Object.values(seen).map((s) => s.accent)).size === MODES.length, JSON.stringify(Object.entries(seen).map(([k, v]) => [k, v.accent])))
check('the five levels use five different symbols', new Set(Object.values(seen).map((s) => s.symbol)).size === MODES.length)
check('every mode shares one geometry', new Set(triggerGeometries).size === 1, JSON.stringify([...new Set(triggerGeometries)]))
check('the menu shows the same five accents as the trigger set', new Set(rowColors.flat()).size === MODES.length, JSON.stringify(rowColors[0]))

// The requested level palette: green for no access, the two yellows for the
// other two, red for full access, and the brand neutral for view-inside.
check('no-access is green', seen['no-access'].accent === 'var(--dsw-alias-state-success-primary)', seen['no-access'].accent)
check('workspace-access wears the brand neutral (white on dark)', seen['workspace-access'].accent === 'var(--dsw-alias-brand-primary)', seen['workspace-access'].accent)
check('read-only wears the fluorescent yellow', seen['read-only'].accent === 'var(--ap-level-read, #eeff00)', seen['read-only'].accent)
check('workspace-write wears the pale yellow', seen['workspace-write'].accent === 'var(--ap-level-write, #f5e3a3)', seen['workspace-write'].accent)
check('danger-full-access is red', seen['danger-full-access'].accent === 'var(--dsw-alias-state-error-primary)', seen['danger-full-access'].accent)
check('both yellow consumers keep a hex fallback', /var\(--ap-level-read, #[0-9a-f]{6}\)/.test(src) && /var\(--ap-level-write, #[0-9a-f]{6}\)/.test(src))

// Those two yellows have no shipped alias, so the plugin owns them — for both
// palettes, on the same `body` / `body[data-ds-dark-theme]` switch the theme uses.
const paletteNode = styleNodes[0]
const paletteCss = String(paletteNode?.textContent ?? '')
const paletteOf = (scope) => {
  const found = paletteCss.match(new RegExp(`${scope}\\{--ap-level-read:(#[0-9a-f]{6});--ap-level-write:(#[0-9a-f]{6})\\}`))
  return found === null ? null : { read: found[1], write: found[2] }
}
const light = paletteOf('body')
const dark = paletteOf('body\\[data-ds-dark-theme\\]')
const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}
const saturation = (hex) => {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(...channels)
  const min = Math.min(...channels)
  return max === 0 ? 0 : (max - min) / max
}
check('the palette style element reaches the page exactly once', styleNodes.length === 1 && paletteNode.selector === 'style[data-plugin-css="dsh-access-permission-level-palette"]', `${styleNodes.length} node(s)`)
check('the palette defines both yellows in both palettes', light !== null && dark !== null, paletteCss)
check('read-only is the saturated neon of the pair, workspace-write the pale one', light !== null && dark !== null && saturation(light.read) > saturation(light.write) && saturation(dark.read) > saturation(dark.write), JSON.stringify({ light, dark }))
check('the light palette darkens both yellows for legibility', light !== null && dark !== null && luminance(light.write) < luminance(dark.write) && luminance(light.read) < luminance(dark.read), JSON.stringify({ light, dark }))

// The readable-files control, same stub, its own state slots.
slots.length = 0; cursor = 0; effects.length = 0
const allowProps = { sessionId: 's1', locked: false, t: (k) => zh[k] ?? k, useProjection: () => ({ currentValue: 'workspace-access' }), ...allowSeat.options.inject('s1') }
cursor = 0; allowSeat.component(allowProps)
for (const f of effects.splice(0)) f()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))
cursor = 0
const allowTree = allowSeat.component(allowProps)
const allowTrigger = triggerOf(allowTree)
check('the readable-files control renders a trigger', allowTrigger !== undefined)
const allowStyle = allowTrigger.props.style
check('both controls share one geometry', geometryOf(allowStyle) === triggerGeometries[0], `\n  mode:  ${triggerGeometries[0]}\n  allow: ${geometryOf(allowStyle)}`)
check('the readable-files control uses a symbol, not an emoji', walk(allowTrigger).some((n) => n.type === 'svg'))
check('the readable-files trigger carries no emoji', !texts(allowTrigger).some((s) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)), JSON.stringify(texts(allowTrigger)))
check('no emoji anywhere in the permission trigger tree', !texts(permissionSeat.component({ sessionId: 's1', locked: false, t: (k) => zh[k] ?? k, useProjection: () => ({ currentValue: 'read-only' }), usePermissionCatalog: () => null, ...permissionSeat.options.inject('s1') })).some((s) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)))
// The folder is a fixed two-tone yellow instead of a theme accent.
const allowIcon = walk(allowTrigger).find((n) => n.type === 'svg')
const folderShapes = allowIcon?.props?.children ?? []
const folderFills = folderShapes.map((shape) => shape?.props?.fill)
check('the readable-files symbol is a solid two-tone folder', folderShapes.length === 2 && folderShapes.every((shape) => shape.type === 'path' && shape.props.stroke === 'none'), JSON.stringify(folderFills))
check('the folder keeps its own colours, not a theme accent', folderFills.length === 2 && new Set(folderFills).size === 2 && folderFills.every((fill) => /^#[0-9a-f]{6}$/i.test(String(fill))), JSON.stringify(folderFills))
// Only the symbol may be coloured: the user asked for the label to be plain text.
const allowLabel = walk(allowTrigger).find((n) => n.props?.children === '额外可读写文件')
check('the readable-files text is plain, not accent-coloured', allowLabel?.props?.style?.color === 'var(--dsw-alias-label-secondary)', String(allowLabel?.props?.style?.color))
check('the readable-files label truncates like the mode label', allowTrigger.props.children.some?.((c) => c?.props?.style?.textOverflow === 'ellipsis') || walk(allowTrigger).some((n) => n.props.style?.textOverflow === 'ellipsis'))
check('no control sets a per-mode font size', !/fontSize:\s*11\.5/.test(src) && !src.includes('letterSpacing'))
check('the control type table exists once', (src.match(/const CONTROL_TYPE = \{/g) ?? []).length === 1)

// A re-applied fiber (the HMR path) must reuse the palette node, not stack tags.
instance.apply(ctxStub)
check('re-applying the fiber reuses the palette node', styleNodes.length === 1, `${styleNodes.length} node(s)`)

// The menu used to carry a version footer (build stamp + row count + which table
// the rows came from). It was a temporary instrument and the user asked for it to
// go, so nothing in the client may re-introduce one.
// The readable-files count has to move when a grant is recorded, which happens
// while an authorization question is being answered: the list is re-read on the
// shipped `userQuestions` projection (and on the step boundary), not on click.
check('the allow list follows the question projection', /useProjection\('userQuestions'/.test(src))
check('the refresh effect depends on that signal', /\[restricted, currentValue, settledQuestions\]/.test(src))
check('no projection is read on every streamed event', !/useProjection\('sessionStats'/.test(src) && !/useProjection\('tokenUsage'/.test(src))
check('the client carries no build footer', !/key: 'build'/.test(src) && !/BUILD/.test(src))
check('the footer wording is gone from the menu code', !/catalogSource/.test(src))

// The two inside-workspace rungs wear each other's glyphs: the guarded folder
// marks read-and-write-inside-workspace (the stricter one), the house marks
// edit-inside-workspace. Locked here so a later edit cannot quietly swap again.
const modeBlock = (key) => {
  const at = src.indexOf(`'${key}': {`)
  return at === -1 ? '' : src.slice(at, src.indexOf("'workspace-write': {", at) === -1 ? at + 400 : at + 400)
}
check('the read-and-write level wears the guarded folder', /symbol: 'workspaceWrite'/.test(modeBlock('workspace-access')))
check('the edit level wears the house', /symbol: 'workspace',/.test(modeBlock('workspace-write')))

// The shipped surfaces (`Menu.module.css`, `Modal.module.css`) are what the
// plugin's popups must look like: a translucent fill over a blurred backdrop on
// the menu, a layer-2 card over the masked, blurred backdrop on the dialog. The
// grey `bg-overlay` token these used to paint with is what read as "偏灰".
const surfaceUses = (src.match(/\.\.\.MENU_SURFACE,/g) ?? []).length
check('all three floating surfaces share one menu material', surfaceUses === 3, `${surfaceUses} use(s)`)
check('the menu material is the shipped translucent fill', /const MENU_SURFACE = \{[\s\S]{0,400}?background: 'var\(--dsw-menu-surface-fill/.test(src))
check('the menu material carries the shipped blur and elevation', /const MENU_SURFACE = \{[\s\S]{0,500}?backdropFilter: 'var\(--dsw-menu-backdrop-filter/.test(src) && /const MENU_SURFACE = \{[\s\S]{0,600}?boxShadow: 'var\(--dsw-elevation-prominent/.test(src))
check('no floating surface paints the grey overlay token', !/background: 'var\(--dsw-alias-bg-overlay\)'/.test(src))
check('the confirmation card sits on the shipped layer-2 surface', /key: 'card',[\s\S]{0,700}?background: 'var\(--dsw-alias-bg-layer-2/.test(src))
check('the confirmation backdrop uses the shipped mask and blur', /background: 'var\(--dsw-alias-bg-mask-1/.test(src) && /backdropFilter: 'var\(--dsw-mask-blur/.test(src) && !/rgba\(0, 0, 0, 0\.35\)/.test(src))
check('the confirmation card layers at the shipped modal depth', /zIndex: 1000/.test(src) && !/zIndex: 1200/.test(src))
check('the confirmation footer uses the shipped button pair', /background: 'var\(--dsw-alias-button-primary-fill\)'[\s\S]{0,120}?color: 'var\(--dsw-alias-label-primary-foreground\)'/.test(src))
check('the level rows take the host hover wash', /\.ap-level-row:hover[^{]*\{background:var\(--dsw-alias-interactive-bg-hover\)/.test(src))
check('the selected row no longer paints an opaque card fill', !/background: active \? 'var\(--dsw-alias-bg-layer-2\)'/.test(src) && /background: active \? 'var\(--dsw-alias-interactive-bg-hover\)'/.test(src))
check('the level rows carry the class the stylesheet targets', /className: 'ap-level-row'/.test(src))

// The risk gate mirrors the shipped `RiskConfirmation` down to its glyphs and
// keyboard behaviour, so the two dialogs read as one component.
const warningBlock = src.slice(src.indexOf('      warning: ['), src.indexOf('      ],', src.indexOf('      warning: [')) + 8)
check('the risk glyph is the shipped circle-and-exclamation', /M8 14\.5C11\.5899/.test(warningBlock) && /M8 4\.29199V9\.79199/.test(warningBlock), warningBlock.slice(0, 120))
check('the close glyph is the shipped X', /close: \[[\s\S]{0,160}?M3\.5 3\.5L12\.5 12\.5/.test(src))
check('the dialog autofocuses the acknowledgement', /'data-modal-autofocus': true/.test(src))
check('Escape closes the dialog', /event\.key === 'Escape' && !event\.shiftKey/.test(src))
check('the mask closes on a click, not on a press', /onClick: closeConfirmation/.test(src) && !/onPointerDown: closeConfirmation/.test(src))
check('the dialog fades in like the shipped modal', /\.ap-dialog-card,\.ap-dialog-mask\{animation:ap-modal-enter/.test(src))

// Regressions from the pre-release review: a projection that arrives late must
// not change the hook count, the menu entry must not read a service it never
// injected, a late answer must not overwrite a newer list, and the resize
// listener must be removable.
const permissionControlAt = src.indexOf('function PermissionControl(props)')
const guardAt = src.indexOf('if (currentValue === undefined) return null', permissionControlAt)
const modalEffectAt = src.indexOf('}, [confirming])', permissionControlAt)
check('the early return sits after the last hook', guardAt > 0 && modalEffectAt > 0 && guardAt > modalEffectAt, `guard@${guardAt} effect@${modalEffectAt}`)
check('the menu entry injects the sessions service it reads', /inject: \[[^\]]*'sessions'/.test(src))
check('the allow list refresh ignores a stale answer', /refreshTicket/.test(src) && /ticket !== refreshTicket\.current/.test(src))
check('the directory listing ignores a stale answer', /listingTicket/.test(src) && /ticket !== listingTicket\.current/.test(src))
check('the resize listener is removed on close', /window\.removeEventListener\('resize', onResize\)/.test(src) && !/addEventListener\('resize', [^)]*once: true/.test(src))

const shortAccent = (accent) => accent.replace(/^var\(--/, '').replace(/, #[0-9a-f]{6}\)$/, '').replace(/\)$/, '')
say(`\n  mode geometry: ${triggerGeometries[0]}`)
say(`  accents: ${Object.entries(seen).map(([k, v]) => `${k}=${shortAccent(v.accent)}`).join('  ')}`)
say(`  yellows: light ${JSON.stringify(light)} · dark ${JSON.stringify(dark)}`)
say(`  readable-files: solid folder ${folderFills.join(' / ')} · plain label ${allowLabel?.props?.style?.color}`)
say(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
