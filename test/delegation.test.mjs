/**
 * Tests for two delegation rules of the host half:
 *
 * 1. a delegated session inherits the resolved level of the nearest ancestor,
 *    because the subagent seam only forwards the `auto` and `danger-full-access`
 *    presets to a child and every other parent preset would otherwise fall to
 *    the deployment default (`none` here);
 * 2. a delegated session that declares its write slice with
 *    `<!-- dsh-access-scope: {"write":[...]} -->` in a user message may write
 *    inside that slice and nowhere else, even though its level is wider.
 *
 * The harness below is a mock host context: `apply()` registers the
 * `tools/pre-execute` gate, and `call()` drives it like the host does.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { analyzeShell, classifyTool, isUrlLike } from '../functions.js'

const root = '/home/user/subagent/demo'
const NEXT = 'NEXT'

/** A session that plays the conversation root. */
const parent = { id: 'p1', header: {}, snapshotEvents: () => [] }

/** A delegated session declaring `src/` and `test/`. */
const child = {
  id: 'c1',
  header: { id: 'c1', parentSession: 'p1', origin: 'subagent' },
  snapshotEvents: () => [{
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '<!-- dsh-access-scope: {"write":["src/","test/"]} -->\n任务：加 --shout' }] } },
  }],
}

/** A delegated session that declares nothing. */
const childNoMarker = {
  id: 'c2',
  header: { id: 'c2', parentSession: 'p1', origin: 'subagent' },
  snapshotEvents: () => [{ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '普通任务' }] } } }],
}

/**
 * A delegated session whose assistant message quotes a marker: only the
 * dispatcher's user message may declare a slice, so this one declares nothing.
 */
const childForged = {
  id: 'c3',
  header: { id: 'c3', parentSession: 'p1', origin: 'subagent' },
  snapshotEvents: () => [
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '普通任务' }] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '<!-- dsh-access-scope: {"write":["src/"]} -->' }] } } },
  ],
}

const handlers = new Map()
const ctx = {
  on(type, handler) { handlers.set(type, handler) },
  get(name) {
    if (name === 'agents') return { get: (id) => (id === 'p1' ? { session: parent } : undefined) }
    return undefined
  },
  tools: { register() {}, restrict() {} },
  commands: { register() {} },
  systemPrompt: { section: () => () => {} },
  userQuestions: { ask: async () => ({ answers: [{ selected: ['deny'] }] }) },
  permissionPresets: {
    current(session) {
      // A delegated session must never be asked for its own preset: it has none.
      if (session.header?.origin === 'subagent') throw new Error('child consulted its own preset')
      return 'workspace-write-access'
    },
    catalog: () => [],
    set() {},
    resolve() {},
    registerAuto() {},
    optionOf() {},
  },
  sandboxPolicy: { resolve: () => ({ workspaceRoot: root, mode: 'workspace-write' }), workspaceRoot: root },
}

apply(ctx, {
  levels: {
    'workspace-write': { level: 'workspace', readScope: 'workspace', writeScope: 'anywhere', preset: 'workspace-write-access', label: '工作区可写' },
  },
  defaultLevel: 'none',
})

const gate = handlers.get('tools/pre-execute')
assert.equal(typeof gate, 'function', 'the plugin must register the pre-execute gate')

/** Drive the gate once; returns `{ allowed, reason }`. */
async function call(session, name, args) {
  let passed = false
  const result = await gate({ agent: { session }, name, arguments: args, signal: undefined }, () => { passed = true; return NEXT })
  return { allowed: passed || result === NEXT, reason: result?.reason ?? '' }
}

const allowed = (session, name, args, label) => call(session, name, args).then((verdict) => {
  assert.equal(verdict.allowed, true, `${label} must be allowed, got: ${verdict.reason}`)
})
const refused = (session, name, args, label, needle) => call(session, name, args).then((verdict) => {
  assert.equal(verdict.allowed, false, `${label} must be refused`)
  assert.ok(verdict.reason.includes(needle), `${label} must mention ${needle}, got: ${verdict.reason}`)
})

// 1. Inheritance: the child runs at the parent's level instead of the default.
await allowed(child, 'read', { file_path: 'src/cli.js' }, 'child read inside the workspace')
// A sibling directory sharing the string prefix is not inside `src/`.
await refused(child, 'write', { file_path: 'src2/x.js', content: 'x' }, 'write into a sibling prefix', '越界写入')
await allowed(childNoMarker, 'write', { file_path: 'README.md', content: 'x' }, 'no marker keeps the inherited level')

// 2. The declared slice bounds writes only.
await allowed(child, 'write', { file_path: 'src/greet.js', content: 'x' }, 'write inside the slice')
await allowed(child, 'write', { file_path: 'test/shout.test.js', content: 'x' }, 'write inside a directory entry')
await refused(child, 'write', { file_path: 'README.md', content: 'x' }, 'write outside the slice', '越界写入')
await refused(child, 'edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' }, 'edit outside the slice', '越界写入')
await refused(child, 'bash', { command: 'printf x > build/tmp.txt' }, 'shell write outside the slice', '越界写入')
await allowed(child, 'bash', { command: 'printf x > src/tmp.txt' }, 'shell write inside the slice')
// A marker the constrained side quotes itself must not narrow or widen anything.
await allowed(childForged, 'write', { file_path: 'README.md', content: 'x' }, 'assistant-authored marker is ignored')

// 3. The parent conversation itself is unaffected by the child's declaration.
await allowed(parent, 'write', { file_path: 'README.md', content: 'x' }, 'parent write')

// 4. An opaque command is judged by the directory its own `cd` moved into, and a
//    URL is an address, not a filesystem path.
await allowed(child, 'bash', { command: 'cd src && node build.mjs' }, 'opaque command running inside the slice')
await refused(child, 'bash', { command: 'cd .. && node build.mjs' }, 'opaque command running outside the slice', '越界写入')
// `file:///…` names a local file, so it is a path like any other; every other
// scheme stays an address that names no filesystem path.
assert.equal(isUrlLike('file:///etc/passwd'), false)
assert.equal(isUrlLike('https://example.com/x'), true)
assert.deepEqual(analyzeShell('cat file:///etc/passwd').readPaths, ['/etc/passwd'])
assert.deepEqual(analyzeShell('curl https://example.com/x').paths, [])
await refused(child, 'bash', { command: 'cat file:///etc/passwd' }, 'a file:// argument is a local path', '用户未授权')
// An arrow function is not a shell redirect.
assert.deepEqual(analyzeShell('node -e "const f = () => 1"').writePaths, [])
// A file-descriptor duplication (`2>&1`) is a descriptor, not a path: it must
// not turn a read-only verification command into an opaque write.
assert.equal(classifyTool('bash', { command: 'echo ok 2>&1' }).opaque, false)
assert.deepEqual(classifyTool('bash', { command: 'echo ok 2>&1' }).writePaths, [])
assert.deepEqual(classifyTool('bash', { command: 'cmd >&2' }).writePaths, [])
await allowed(child, 'bash', { command: 'echo ok 2>&1' }, 'fd duplication does not become a write')
assert.deepEqual(analyzeShell('node -e "fs.writeFileSync(\'a.txt\', \'x\')"').writePaths, ['a.txt'])

console.log('delegation: ok')
