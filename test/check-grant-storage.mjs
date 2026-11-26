import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGrantStorage, GRANT_DOMAIN } from '../grant-storage.js'
import { apply } from '../index.js'

const absolute = (...parts) => join(parse(tmpdir()).root, ...parts)
const full = { version: 1, readAllow: [absolute('example', 'manual')], grants: [
  { path: absolute('example', 'standing'), directory: true, read: true, write: false },
] }
const cleared = { version: 1, readAllow: [], grants: [] }
let medium = new Map()
async function exercise(newFacility) {
  async function cycle(job) {
    const { facility, dispose } = await newFacility()
    const primary = createGrantStorage({ facility, namespace: 'profile-A' })
    try { await job(primary, facility) } finally { await primary.close(); await dispose() }
  }
  await cycle(async (primary) => {
    assert.equal(await primary.load('original'), undefined)
    await primary.save('original', full)
    await assert.rejects(primary.save('bad-version', { ...full, version: 2 }), /Invalid authorization snapshot/)
    await assert.rejects(primary.save('bad-grant', {
      ...full, grants: [{ ...full.grants[0], write: 'true' }],
    }), /Invalid authorization entry/)
  })
  await cycle(async (primary, facility) => {
    assert.deepEqual(await primary.load('original'), full)
    assert.equal(await primary.load('new-conversation'), undefined)
    await primary.save('original', cleared)
    await primary.close()
    const other = createGrantStorage({ facility, namespace: 'profile-B' })
    try { assert.equal(await other.load('original'), undefined) } finally { await other.close() }
  })
  await cycle(async (primary) => {
    assert.deepEqual(await primary.load('original'), cleared)
  })
}

const records = new Map()
const parent = { id: 'original', header: {} }
const fresh = { id: 'new', header: {} }
const child = { id: 'child', header: { origin: 'subagent', parentSession: parent.id } }
const fork = { id: 'fork', header: { parentSession: parent.id } }
const grantDir = absolute('opt', 'gate-persistence')
const outside = join(grantDir, 'item.txt')
const manualPath = absolute('opt', 'gate-manual.txt')
const manualWriteDir = absolute('opt', 'gate-manual-write')

if (process.argv.length > 2) {
  const { DomainFacility } = await import(pathToFileURL(process.argv[2]))
  const { JsonStorageBackend } = await import(pathToFileURL(process.argv[3]))
  const openAt = (directory, routed) => async () => {
    const expected = routed ? 'isolated' : 'json'
    const json = new JsonStorageBackend(directory)
    const ctx = { storage: { backend: { get: (key) => {
      assert.equal(key, expected, 'grant domain must use the selected backend')
      return json
    } } }, emit() {} }
    const facility = new DomainFacility(ctx, {
      backend: 'json', routes: routed ? { [GRANT_DOMAIN]: expected } : {},
    })
    return { facility, dispose: () => json.close() }
  }
  const [directory, route, phase] = process.argv.slice(4)
  if (directory !== undefined) {
    await exerciseHostOnDisk(openAt(directory, route === 'routed'), Number(phase))
    process.exit(0)
  }
  const root = await mkdtemp(join(tmpdir(), 'gate-storage-'))
  try {
    for (const route of ['default', 'routed']) {
      await exercise(openAt(join(root, `${route}-adapter`), route === 'routed'))
      for (let phase = 0; phase < 4; phase++) {
        const result = spawnSync(process.execPath, [
          ...process.argv.slice(1, 4), join(root, route), route, String(phase),
        ], { encoding: 'utf8', timeout: 30_000 })
        if (result.error) throw result.error
        assert.equal(result.status, 0, `${route}, process ${phase}: ${result.stderr || result.stdout}`)
      }
    }
  } finally { await rm(root, { recursive: true }) }
} else {
  await exercise(async () => {
    let open = false
    const facility = { async open(spec) {
      assert.equal(spec.name, GRANT_DOMAIN)
      assert.equal(spec.layout, 'per-record')
      assert.equal(open, false)
      open = true
      for (const value of medium.values()) spec.tables.sessions.valueSchema.parse(value)
      return { table(name) {
        assert.equal(name, 'sessions')
        return { get: (key) => medium.get(key), async put(key, value) { medium.set(key, structuredClone(value)) } }
      }, async close() { open = false } }
    } }
    return { facility, dispose() { assert.equal(open, false) } }
  })
  const unavailable = createGrantStorage({ namespace: 'profile-A', facility: { async open() { throw new Error('offline') } } })
  await assert.rejects(unavailable.load('original'), /offline/)
  await unavailable.close()
}

function host({ mode = 'protected-backend', readFails = false, writeFails = false,
  profile = absolute('opt', 'profile-a'), duringPut, storageFacility } = {}) {
  let hook, command, cleanup, disposeSession
  let preset = 'work'
  let answer = '不允许'
  let opens = 0
  const facility = storageFacility ?? { async open() {
    opens++
    if (readFails) throw new Error('unreadable medium')
    return { async close() {}, table: () => ({
      get: (key) => records.get(key),
      async put(key, value) {
        if (writeFails) throw new Error('unwritable medium')
        await duringPut?.()
        records.set(key, structuredClone(value))
      },
    }) }
  } }
  apply({
    on(event, fn) {
      if (event === 'tools/pre-execute') hook = fn
      if (event === 'session/disposed') disposeSession = fn
    },
    effect(fn) { cleanup = fn() },
    get(name) { return {
      storageDomain: facility, profileContext: { dir: profile },
      sessions: { get: (key) => key === parent.id ? parent : undefined },
    }[name] },
    commands: { register(definition) { command = definition.handler } },
    userQuestions: { ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: [answer] }] }) },
    permissionPresets: { current: () => preset },
    sandboxPolicy: { resolve: () => ({ workspaceRoot: absolute('home', 'user', 'project'), mode: 'workspace-write' }) },
  }, { levels: {
    work: { level: 'workspace', readScope: 'workspace', writeScope: 'workspace' },
    off: { level: 'none', readScope: 'none', writeScope: 'none' },
  }, grantPersistence: mode })
  return {
    async read(session, path = outside) {
      return (await hook({ agent: { session }, name: 'read', arguments: { file_path: path } }, () => ({ kind: 'allow' }))).kind
    },
    async write(session, path) {
      return (await hook({ agent: { session }, name: 'write', arguments: { file_path: path } }, () => ({ kind: 'allow' }))).kind
    },
    command: (session, rawInput) => command({ agent: { session }, rawInput }),
    answer(value) { answer = value },
    setPreset(value) { preset = value },
    disposeSession: (session) => disposeSession(session),
    opened: () => opens,
    close: async () => cleanup?.(),
  }
}
async function exerciseHostOnDisk(openFacility, phase) {
  async function command(plugin, input) {
    const result = await plugin.command(parent, input)
    assert.equal(result.kind, 'success', `${input}: ${result.text}`)
  }
  const phases = [
    async (plugin) => {
      plugin.answer('该对话中总是可以访问')
      assert.equal(await plugin.read(parent), 'allow')
      assert.equal((await plugin.command(parent, `add "${manualPath}"`)).kind, 'success')
      assert.equal((await plugin.command(parent, `add-write "${manualWriteDir}"`)).kind, 'success')
    },
    async (plugin) => {
      assert.equal(await plugin.read(parent), 'allow')
      assert.equal(await plugin.read(child), 'allow')
      assert.equal(await plugin.read(fresh), 'deny')
      assert.equal(await plugin.read(fork), 'deny')
      assert.equal(await plugin.read(parent, manualPath), 'allow')
      assert.equal(await plugin.write(parent, manualWriteDir), 'allow')
      await command(plugin, `remove-write "${manualWriteDir}"`)
      await command(plugin, `remove "${grantDir}"`)
      assert.equal(await plugin.read(child), 'deny')
    },
    async (plugin) => {
      assert.equal(await plugin.read(parent), 'deny')
      assert.equal(await plugin.write(parent, manualWriteDir), 'deny')
      assert.equal(await plugin.read(parent, manualPath), 'allow')
      assert.equal((await plugin.command(parent, 'clear')).kind, 'success')
    },
    async (plugin) => {
      assert.equal(await plugin.read(parent, manualPath), 'deny')
    },
  ]
  assert.equal(typeof phases[phase], 'function')
  const { facility, dispose } = await openFacility()
  const plugin = host({ storageFacility: facility })
  try { await phases[phase](plugin) } finally { await plugin.close(); await dispose() }
}
let instance = host()
instance.answer('仅一次')
assert.equal(await instance.read(parent), 'allow')
assert.equal(records.size, 0)
instance.answer('不允许')
assert.equal(await instance.read(parent), 'deny')
assert.equal(records.size, 0)
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(parent), 'allow')
assert.equal((await instance.command(parent, `add "${manualPath}"`)).kind, 'success')
await instance.close()
instance = host()
assert.equal(await instance.read(parent), 'allow')
assert.equal(await instance.read(fresh), 'deny')
assert.equal(await instance.read(fork), 'deny')
assert.equal(await instance.read(child), 'allow')
assert.match((await instance.command(parent, 'list')).text, /gate-manual/)
assert.equal((await instance.command(parent, `remove "${absolute('opt', 'gate_persistence')}"`)).kind, 'error')
assert.equal((await instance.command(parent, `remove "${grantDir}"`)).kind, 'success')
assert.equal(await instance.read(child), 'deny')
await instance.close()
instance = host()
assert.equal(await instance.read(parent), 'deny')
assert.match((await instance.command(parent, 'list')).text, /gate-manual/)
assert.equal((await instance.command(parent, 'clear')).kind, 'success')
await instance.close()
instance = host()
assert.doesNotMatch((await instance.command(parent, 'list')).text, /gate-manual/)
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(parent), 'allow')
await instance.close()
for (const options of [{ readFails: true }, { profile: absolute('opt', 'profile-b') }]) {
  instance = host(options)
  assert.equal(await instance.read(parent), 'deny')
  await instance.close()
}
instance = host({ writeFails: true })
assert.equal(await instance.read(parent), 'allow')
assert.equal((await instance.command(parent, 'clear')).kind, 'error')
assert.equal(await instance.read(parent), 'deny')
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(parent), 'deny')
await instance.close()
instance = host({ mode: 'memory' })
assert.equal(await instance.read(parent), 'deny')
assert.equal(instance.opened(), 0)
assert.match((await instance.command(parent, 'list')).text, /仅在本次运行有效/)
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(fresh), 'allow')
instance.answer('不允许')
assert.equal(await instance.read(fresh), 'allow')
assert.equal(instance.opened(), 0)
await instance.close()
instance = host({ mode: 'memory' })
assert.equal(await instance.read(fresh), 'deny')
await instance.close()
instance = host({ duringPut: () => instance.setPreset('off') })
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(fresh), 'deny', 'a preset narrowed during storage must not allow the pending operation')
await instance.close()
instance = host({ duringPut: () => instance.disposeSession(fork) })
instance.answer('该对话中总是可以访问')
assert.equal(await instance.read(fork), 'deny', 'a disposed session must not publish a late grant')
assert.equal(await instance.read(fork), 'deny')
await instance.close()

const revokeStarted = Promise.withResolvers()
const continueRevoke = Promise.withResolvers()
instance = host({ duringPut: () => {
  revokeStarted.resolve()
  return continueRevoke.promise
} })
try {
  assert.equal(await instance.read(child), 'allow')
  const revoking = instance.command(parent, 'clear')
  await revokeStarted.promise
  const concurrentRead = instance.read(child)
  continueRevoke.resolve()
  assert.equal((await revoking).kind, 'success')
  assert.equal(await concurrentRead, 'deny', 'delegated reads wait for pending parent revocations')
} finally {
  continueRevoke.resolve()
  await instance.close()
}
console.log('grant storage: ALL PASS')
