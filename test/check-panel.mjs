import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const REPO = fileURLToPath(new URL('..', import.meta.url))
const say = (...a) => process.stdout.write(a.join(' ') + '\n')
let failures = 0
const check = (l, ok, extra = '') => { if (ok) say('ok   ' + l); else { failures += 1; say('FAIL ' + l + '  ' + extra) } }
const src = fs.readFileSync(`${REPO}/client.js`, 'utf8')
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
globalThis.document = { addEventListener() {}, removeEventListener() {}, body: {} }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
new Function(src)()
const instance = captured.factory((n) => {
  if (n === 'react') return react
  if (n === 'react-dom') return { createPortal: (el) => el }
  throw new Error('require ' + n)
})
const regs = []
// Every read of the allowlist leaves through `commands.execute('/access-allow
// list')`; counting there catches a read issued from any render's closure.
let listReads = 0
// The session status store is the client-visible edge of a question panel: it
// publishes the pending interaction while the dialog is up and drops it when
// the answer is in. The control watches it because the gate asks through the
// user-questions service, which never writes a `tool/call` event.
let statusSnapshot = new Map([['s1', { running: true, pendingInteraction: { key: 'p' }, completionUnread: false }]])
const statusListeners = new Set()
const statusStore = {
  getSnapshot: () => statusSnapshot,
  subscribe(listener) { statusListeners.add(listener); return () => { statusListeners.delete(listener) } },
}
const notifyStatus = () => { for (const listener of [...statusListeners]) listener() }
instance.apply({
  effect(fn) { const d = fn(); return d ?? (() => {}) },
  locale: { register: () => () => {}, bind: () => (k) => zh[k] ?? k }, on() {},
  uiSession: { sessionStatus: statusStore },
  slots: { inject(k, cb) { regs.push({ key: k, ...cb() }); return () => {} }, register: (o, c) => ({ options: o, component: c }) },
  commandUi: { register() { return () => {} } }, sessions: { binding: () => undefined },
  remote: { $on: () => () => {}, permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
    directoryPicker: {
      pick: async () => ({ ok: true, value: null }),
      // Mirror the generated client's argument counting: `list` declares one
      // business argument, and a call with none throws before reaching the host.
      list: async (...args) => {
        if (args.length === 0) throw new Error('client api: directoryPicker/list expected 1 business argument(s) plus an optional AbortSignal, got 0')
        const path = args[0]
        // /mnt is where WSL mounts the Windows drives: one directory per drive
        // letter plus housekeeping folders the browser must not offer.
        if (path === '/mnt') return { ok: true, value: {
          path: '/mnt', home: '/home/user',
          crumbs: [{ name: '/', path: '/' }, { name: 'mnt', path: '/mnt' }],
          entries: [
            { name: 'c', path: '/mnt/c' },
            { name: 'd', path: '/mnt/d' },
            { name: 'wsl', path: '/mnt/wsl' },
          ], truncated: false,
        } }
        return { ok: true, value: {
        path: '/home/user', home: '/home/user',
        crumbs: [{ name: '/', path: '/' }, { name: 'user', path: '/home/user' }],
          entries: [{ name: 'workspace', path: '/home/user/workspace' }], truncated: false,
        } }
      },
    },
    commands: {
      execute: async (sid, line) => {
        if (typeof line === 'string' && line.startsWith('/access-allow list')) listReads += 1
        return { ok: true, value: { result: { kind: 'success', text: '额外可读写文件（可读 2 项、可写 1 项） [allow: %2Ftmp%2Fa|rw\u0001%2Ftmp%2Fb|r\u0001%2Ftmp%2Fc|wd]' } } }
      },
    } },
})
const seat = regs.find((r) => r.key === 'conversation.input.right')
const injected = seat.options.inject('s1')
// The listing action must reach the host: the generated client rejects a call
// that omits the declared business argument (the fixture throws the same text).
const listedHome = await injected.listDirectory(null)
check('the listing action lists the default folder', listedHome.failure === undefined && listedHome.listing?.path === '/home/user', JSON.stringify(listedHome))
const listedPath = await injected.listDirectory('/home/user/workspace')
check('the listing action lists an explicit folder', listedPath.failure === undefined && listedPath.listing?.path === '/home/user', JSON.stringify(listedPath))
check('the listing action never calls the remote list empty-handed', !/directoryPicker\.list\(\s*\)/.test(src))
const props = { sessionId: 's1', locked: false, t: (k) => zh[k] ?? k, useProjection: () => ({ currentValue: 'workspace-access' }), ...injected }
// First render initialises the state slots, and its effects start the host
// read; the reply is asynchronous, so settle it before re-rendering.
cursor = 0; seat.component(props)
for (const f of effects.splice(0)) f()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))
slots[0] = true // useState #0 of AllowControl is `open`
slots[3] = false
cursor = 0
const closedTree = seat.component(props)
slots[3] = true // useState #3 is `adding`: it swaps the buttons for the input
cursor = 0
const tree = { closedTree, open2: seat.component(props) }
// Collect string children AND the label-bearing props a reader actually sees.
const texts = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  for (const key of ['placeholder', 'aria-label', 'title']) {
    const v = node.props?.[key]
    if (typeof v === 'string' && v !== '') out.push(v)
  }
  const kids = node.props?.children
  for (const c of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) texts(c, out)
  return out
}
const shown = [...texts(tree.closedTree), ...texts(tree.open2)].filter((s) => s.trim() !== '')
say('panel text, as rendered:')
for (const s of shown) say('   ' + JSON.stringify(s))
say('')
for (const want of ['额外可读写文件', '额外可读文件', '额外可写文件', '上面一框', '移除', '选择目录…', '手动输入路径', '输入文件或目录的完整路径', '添加'])
  check('panel shows: ' + want, shown.some((s) => s.includes(want)))
check('no raw key survives in the panel', !shown.some((s) => /^(allow|enter|pick|remove|confirm)[A-Z]/.test(s)), JSON.stringify(shown))
check('the two host entries are listed', shown.includes('/tmp/a') && shown.includes('/tmp/b'), JSON.stringify(shown))
// A legacy marker field is read-only, so every fixture row is readable. A write
// also implies its read (`/tmp/c` carries only `w`), so all three rows show in
// the read box while the write box keeps only the two writable ones. The open
// tree is read on its own: the closed tree is rendered too, so `shown` holds two
// copies of every box.
const openShown = texts(tree.open2)
const countIn = (list, want) => list.filter((s) => s === want).length
const writeAt = openShown.findIndex((s) => s === '额外可写文件')
const readBox = openShown.slice(0, writeAt)
const writeBox = openShown.slice(writeAt)
// A `d` flag marks a directory entry, which the panel shows with a trailing
// separator so the row says what it covers. The fixture's `/tmp/c` is write-only.
check('a directory row is drawn with a trailing separator', openShown.includes('/tmp/c/'))
check(
  'a write row appears in the read box through its implied read',
  writeAt > 0 && countIn(readBox, '/tmp/a') > 0 && countIn(readBox, '/tmp/c/') > 0,
  JSON.stringify({ writeAt }),
)
check(
  'the read box lists every readable row',
  writeAt > 0 && countIn(readBox, '/tmp/a') > 0 && countIn(readBox, '/tmp/b') > 0 && countIn(readBox, '/tmp/c/') > 0,
  JSON.stringify({ writeAt }),
)
check(
  'the write box lists only the writable rows',
  countIn(writeBox, '/tmp/a') > 0 && countIn(writeBox, '/tmp/c/') > 0 && countIn(writeBox, '/tmp/b') === 0,
  JSON.stringify({ writeAt }),
)
check('the client reads the directory flag', /flags\.includes\('d'\)/.test(src) && /row\.directory === true/.test(src))
check('the read box filters on the readable family', /row\.readable === true \|\| row\.read === true/.test(src))
check('the implied read is explained on its remove button', /title: family === 'read' && row\.write === true \? props\.t\('removeImpliedRead'\)/.test(src))
check('the boxes are rendered in the source', /familyBox\('read', 'readBoxTitle'/.test(src) && /familyBox\('write', 'writeBoxTitle'/.test(src))
// Each box carries its own copy of the add pair, so a click can only touch the
// family that box is about. The fixture's first render is not editing.
const closedTexts = texts(tree.closedTree)
const pairCount = (want) => closedTexts.filter((s) => s === want).length
check('each box carries its own add pair', pairCount('选择目录…') >= 2 && pairCount('手动输入路径') >= 2, JSON.stringify({ pick: pairCount('选择目录…'), manual: pairCount('手动输入路径') }))
check('the add pair is wired to the box family', /startAdding\(family\)/.test(src) && /add\(draft, family\)/.test(src) && /chooseDirectory\(family\)/.test(src) && /remove\(row\.path, family\)/.test(src))
check('the add menu falls back to the in-app browser', /requestBrowser\(session\.sessionId, 'read'\)/.test(src))
check('the in-app browser is offered when the system dialog is missing', /pickFallback/.test(src) && /无法打开目录选择器/.test(src) === false)
check('the control injects the listing action', /listDirectory: async \(path\)/.test(src))
// ---- folder-browser fallback, driven through the real click handler ----
// The system dialog is unavailable on machines without a native backend, so the
// control falls back to the in-app browser. Its listing arrives asynchronously;
// the refresh must keep the anchor captured when the browser opened — a
// replacement object without it crashes the next render and the slot drops the
// whole control (the panel visibly disappears).
slots[0] = true // open
slots[3] = false // not editing
const failing = { ...injected, pickDirectory: async () => { throw new Error('directory-picker/unavailable') } }
const propsFallback = { ...props, ...failing }
const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return
  visit(node)
  const kids = node.props?.children
  for (const c of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) walk(c, visit)
}
const findButton = (node, label) => {
  let hit = null
  walk(node, (n) => {
    if (hit !== null || n.type !== 'button') return
    const kids = n.props?.children
    const list = Array.isArray(kids) ? kids : [kids]
    if (list.some((c) => typeof c === 'string' && c.includes(label))) hit = n
  })
  return hit
}
cursor = 0
const openTree = seat.component(propsFallback)
const pickButton = findButton(openTree, zh.pickDirectory)
check('the folder button is rendered when the panel is open', pickButton !== null)
if (pickButton !== null) pickButton.props.onClick()
for (let tick = 0; tick < 3; tick += 1) await new Promise((r) => setTimeout(r, 0))
let fallbackTree = null
let fallbackCrash = ''
try {
  cursor = 0
  fallbackTree = seat.component(propsFallback)
} catch (cause) {
  fallbackCrash = cause instanceof Error ? cause.message : String(cause)
}
check('the fallback browser survives its async listing refresh', fallbackCrash === '', fallbackCrash)
const fallbackTexts = fallbackTree === null ? [] : texts(fallbackTree)
check(
  'the fallback browser lists the default folder after the click',
  fallbackTexts.includes(zh.browseTitle) && fallbackTexts.includes('workspace'),
  JSON.stringify(fallbackTexts.slice(0, 10)),
)
check('the control keeps its trigger after the fallback', fallbackTexts.some((s) => s.includes('额外可读写文件')), JSON.stringify(fallbackTexts.slice(0, 6)))
// Windows drives are ordinary directories under /mnt in WSL, so the browser
// reads that level once when it opens and offers the drive letters as chips:
// otherwise a drive is only reachable by walking the breadcrumbs to / then /mnt.
check(
  'the browser offers the fixed quick places',
  fallbackTexts.includes(zh.browsePlaces) && fallbackTexts.includes(zh.browseWslRoot) && fallbackTexts.includes(zh.browseCrumbHome),
  JSON.stringify(fallbackTexts.slice(0, 12)),
)
check('the browser offers every Windows drive it found', fallbackTexts.includes('C:') && fallbackTexts.includes('D:'), JSON.stringify(fallbackTexts.slice(0, 16)))
check('the browser does not offer /mnt housekeeping folders as drives', !fallbackTexts.includes('WSL:') && !fallbackTexts.includes('W:'), JSON.stringify(fallbackTexts.slice(0, 16)))
check('a quick place jumps straight to that folder', /onClick: \(\) => loadListing\(browse\.family, place\.path\)/.test(src))
// Render the browser with one settled listing: the dialog has to name itself,
// offer the crumbs and the child folder, and carry the fallback note.
slots[0] = false
slots[13] = {
  family: 'read',
  listing: {
    path: '/home/user', home: '/home/user',
    crumbs: [{ name: '/', path: '/' }, { name: 'user', path: '/home/user' }],
    entries: [{ name: 'workspace', path: '/home/user/workspace' }],
    truncated: false,
  },
  busy: false, failure: null, note: zh.pickFallback + 'no zenity', anchor: { left: 10, bottom: 10 },
}
cursor = 0
const browseTexts = texts(seat.component(props))
check('the browser dialog names itself', browseTexts.includes(zh.browseTitle), JSON.stringify(browseTexts.slice(0, 6)))
check('the browser shows the current folder', browseTexts.some((s) => s.includes('/home/user')), JSON.stringify(browseTexts.slice(0, 8)))
check('the browser shows the child folder', browseTexts.includes('workspace'), JSON.stringify(browseTexts.slice(0, 12)))
check('the browser offers the actions', browseTexts.includes(zh.browseChoose) && browseTexts.includes(zh.browseUp) && browseTexts.includes(zh.browseCrumbHome))
check('the browser explains the fallback', browseTexts.some((s) => s.includes(zh.pickFallback)))
check('the panel title names both families', shown.some((s) => s.includes('额外可读写文件')), JSON.stringify(shown))
// ---- the count follows the answered dialog, not the click ----
// The host records the grant while the shipped question panel is up; the panel
// is a pending interaction on the session status store, so its disappearance is
// the edge the control has to read on. A status change that leaves the dialog
// where it was must not read: most status notifications mean nothing here.
slots[0] = false
const statusProps = { ...props, statusStore }
cursor = 0
effects.length = 0
seat.component(statusProps)
for (const fn of effects.splice(0)) fn()
for (let tick = 0; tick < 2; tick += 1) await new Promise((r) => setTimeout(r, 0))
listReads = 0
statusSnapshot = new Map([['s1', { running: true, pendingInteraction: { key: 'p' }, completionUnread: true }]])
notifyStatus()
for (let tick = 0; tick < 2; tick += 1) await new Promise((r) => setTimeout(r, 0))
check('an unrelated status change does not read the list', listReads === 0, JSON.stringify({ listReads }))
listReads = 0
// The answer lands: the panel is gone and the turn is winding down.
statusSnapshot = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: false }]])
notifyStatus()
for (let tick = 0; tick < 2; tick += 1) await new Promise((r) => setTimeout(r, 0))
check('an answered dialog makes the control re-read the list', listReads >= 1, JSON.stringify({ listReads }))

say(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)
