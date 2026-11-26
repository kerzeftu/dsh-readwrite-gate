/**
 * Host-side gate test for the readwrite-gate plugin.
 *
 * It loads the REAL plugin entry with a fake cordis context and replays the
 * `tools/pre-execute` waterfall over the five rungs of the ladder, reading the
 * level table straight out of the shipped `cordis.patch.yml` so the test fails
 * if the patch file and the code ever disagree.
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, grantQuestionId } from '../index.js'
import { analyzeShell, normalizeUserPath } from '../functions.js'

/** The repository root, so the suite runs from any checkout. */
const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
/** Fixture workspace: inside the checkout, so no privileges are needed. */
const ROOT = join(realpathSync(PLUGIN), 'test', 'fixtures', 'ws')
/** The home directory the typed-path cases pretend to see. */
const TEST_HOME = '/home/user'
const INSIDE = `${ROOT}/a.txt`
const OUTSIDE = '/opt/evil.txt'
const OTHER_OUTSIDE = '/etc/hosts'
const WIDE = { read: 'anywhere', write: 'anywhere' }

let failures = 0
let checks = 0
function check(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/* ---------------------------------------------------------------- yml --- */

const yml = readFileSync(`${PLUGIN}/cordis.patch.yml`, 'utf8')
const ymlLines = yml.split('\n')
const levelsHead = ymlLines.indexOf('        levels:')
if (levelsHead === -1) throw new Error('cordis.patch.yml: no `levels:` block')
const levels = {}
let current = undefined
for (let i = levelsHead + 1; i < ymlLines.length; i += 1) {
  const line = ymlLines[i]
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  const indent = line.length - line.trimStart().length
  if (indent <= 8) break
  if (indent === 10) {
    current = trimmed.replace(/:$/, '')
    levels[current] = {}
    continue
  }
  const colon = line.indexOf(':')
  levels[current][line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
}
const defaultLevel = /^ {8}defaultLevel: (.+)$/m.exec(yml)?.[1].trim()
const treatReadOnly = /^ {8}treatReadOnlyAsNoAccess: (.+)$/m.exec(yml)?.[1].trim()
const opaquePolicy = /^ {8}opaquePolicy: (.+)$/m.exec(yml)?.[1].trim()

check('yml lists five levels', Object.keys(levels).length, 5)
check('yml defaultLevel', defaultLevel, 'no-access')
check('yml treatReadOnlyAsNoAccess', treatReadOnly, 'false')
check('yml opaquePolicy', opaquePolicy, 'directory')
check('yml workspace-edit scopes', [levels['workspace-edit'].readScope, levels['workspace-edit'].writeScope], ['workspace', 'workspace'])
check('yml read-only-access scopes', [levels['read-only-access'].readScope, levels['read-only-access'].writeScope], ['anywhere', 'none'])
check('yml workspace-write-access scopes', [levels['workspace-write-access'].readScope, levels['workspace-write-access'].writeScope], ['anywhere', 'workspace'])
check('yml no-access is level none', levels['no-access'].level, 'none')
check('yml full-access is level full', levels['full-access'].level, 'full')
// The preset table and the level table must name the same capability.
for (const [key, entry] of Object.entries(levels)) {
  if (entry.preset === undefined) continue
  check(`yml preset ${key} is declared in the preset table`, yml.includes(`      ${entry.preset}:`), true)
}
check(
  'yml workspace-access sandbox is workspace-write',
  /^ {6}workspace-access:\n {8}sandbox: (.+)$/m.exec(yml)?.[1].trim(),
  'workspace-write',
)

/* --------------------------------------------------------------- ctx --- */

let currentPreset = 'workspace-access'
let dialogAnswer = '不允许'
let askCount = 0
let lastDialog = undefined
const handlers = new Map()
const commands = new Map()
const session = { id: 'sess-1', snapshotEvents: () => [] }
const agent = { session }

const ctx = {
  on: (event, handler) => { handlers.set(event, handler) },
  effect: () => () => {},
  systemPrompt: { section: () => () => {} },
  commands: { register: (definition) => { commands.set(definition.name, definition) } },
  permissionPresets: {
    current: () => currentPreset,
    catalog: () => ({ presets: [] }),
  },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT }) },
  userQuestions: {
    ask: async (request) => {
      askCount += 1
      const question = request.questions[0]
      lastDialog = question
      return { answers: [{ id: question.id, selected: [dialogAnswer] }] }
    },
  },
}

// The raw row configuration is handed to `apply` exactly as the host would, so
// the plugin's own normalization runs too.
apply(ctx, { levels, defaultLevel, treatReadOnlyAsNoAccess: treatReadOnly === 'true', opaquePolicy })
const gate = handlers.get('tools/pre-execute')
if (gate === undefined) throw new Error('plugin registered no tools/pre-execute handler')
const next = async () => ({ kind: 'allow', via: 'next' })

async function run(preset, name, args) {
  currentPreset = preset
  askCount = 0
  lastDialog = undefined
  return gate({ agent, name, arguments: args }, next)
}
const read = (path) => ['read', { file_path: path }]
const write = (path) => ['write', { file_path: path, content: 'x' }]
const shell = (command) => ['bash', { command }]

/* ------------------------------------------------------------ ladder --- */

async function verdict(preset, spec) {
  const result = await run(preset, spec[0], spec[1])
  return result?.kind
}

// 无权限: nothing at all, and no dialog is ever opened.
check('no-access read inside', await verdict('no-access', read(INSIDE)), 'deny')
check('no-access read outside', await verdict('no-access', read(OUTSIDE)), 'deny')
check('no-access write inside', await verdict('no-access', write(INSIDE)), 'deny')
check('no-access opens no dialog', askCount, 0)

// 工作区内编辑: reads and writes inside; reads outside ask, writes outside are
// asked for and then refused (the dialog records a grant, the preset's sandbox is
// what ultimately fences an outside write).
check('workspace-access read inside', await verdict('workspace-access', read(INSIDE)), 'allow')
check('workspace-access read outside asks and is refused', await verdict('workspace-access', read(OUTSIDE)), 'deny')
check('workspace-access asked once', askCount, 1)
check('workspace-access dialog header', lastDialog?.header, '请求访问授权')
check('read dialog names the outside reason', lastDialog?.detail.includes('涉及工作区和临时目录以外的路径'), true)
check('read dialog lists the resolved target separately', lastDialog?.detail.includes(`**触发授权的路径或目录**\n\n    ${OUTSIDE}`), true)
check('read dialog includes the workspace', lastDialog?.detail.includes(`**工作区**\n\n    ${ROOT}`), true)
check('workspace-access dialog options', lastDialog?.options.map((o) => o.label), ['不允许', '仅一次', '该对话中总是可以访问'])
check('dialog grant label names the family', [lastDialog?.options[2].label], ['该对话中总是可以访问'])
check('workspace-access write inside', await verdict('workspace-access', write(INSIDE)), 'allow')
check('workspace-access write inside opens no dialog', askCount, 0)
check('workspace-access write outside asks', await verdict('workspace-access', write(OUTSIDE)), 'deny')
check('workspace-access write outside was asked', askCount, 1)
check('workspace-access write outside header', lastDialog?.header, '请求修改授权')
check('write dialog warns about the separate sandbox check', lastDialog?.detail.includes('仍须通过 DSH 沙箱检查'), true)
check('workspace-access shell rm outside asks', await verdict('workspace-access', shell('rm -rf /opt/x')), 'deny')
check('workspace-access shell rm outside was asked', askCount, 1)
check('workspace-access shell ls outside asks', await verdict('workspace-access', shell('ls /opt')), 'deny')
check('workspace-access shell listed the dialog', askCount, 1)
check('unresolved path still asks and fails closed', await verdict('workspace-access', read('~someone/relative.txt')), 'deny')
check('unresolved path was not presented as a resolved target', lastDialog?.detail.includes('~someone/relative.txt（未解析）'), true)
check('path with a line break still asks', await verdict('workspace-access', read('/opt/note\n# Heading.txt')), 'deny')
check('line breaks in a path stay literal inside the explanation', lastDialog?.detail.includes('/opt/note\\u000a# Heading.txt'), true)
const morePaths = Array.from({ length: 9 }, (_, i) => `/opt/dialog/dir-${i}/file.txt`)
check('a multi-path request still asks', await verdict('workspace-access', shell(`cat ${morePaths.join(' ')}`)), 'deny')
check('a long list reports hidden targets', lastDialog?.detail.includes('另有 1 项未展示。'), true)
check('display truncation leaves the standing grant scope intact', lastDialog?.options[2].description.includes('/opt/dialog/dir-8/'), true)

// The platform temp area (`/tmp` and `os.tmpdir()`) counts as inside the
// sandbox's writable roots, so neither family asks about it — a dialog there
// would only be noise.
const TEMP = '/tmp/ap-temp-note.txt'
check('workspace-access read in the temp area', await verdict('workspace-access', read(TEMP)), 'allow')
check('the temp area read opens no dialog', askCount, 0)
check('workspace-access write in the temp area', await verdict('workspace-access', write(TEMP)), 'allow')
check('the temp area write opens no dialog', askCount, 0)
check('workspace-access shell inside the temp area', await verdict('workspace-access', shell('rm -rf /tmp/ap-temp-dir')), 'allow')
check('the temp area shell opens no dialog', askCount, 0)
check('workspace-write write in the temp area', await verdict('workspace-write', write(TEMP)), 'allow')
check('read-only still refuses a temp area write', await verdict('read-only', write(TEMP)), 'deny')
check('no-access still refuses a temp area read', await verdict('no-access', read(TEMP)), 'deny')

// 只读: any path is readable, nothing may be modified.
check('read-only read inside', await verdict('read-only', read(INSIDE)), 'allow')
check('read-only read outside', await verdict('read-only', read(OUTSIDE)), 'allow')
check('read-only read outside opens no dialog', askCount, 0)
check('read-only write inside', await verdict('read-only', write(INSIDE)), 'deny')
check('read-only write outside', await verdict('read-only', write(OUTSIDE)), 'deny')

// 工作区可写: reads anywhere, writes inside the workspace, asks outside.
check('workspace-write read outside', await verdict('workspace-write', read(OUTSIDE)), 'allow')
check('workspace-write write inside', await verdict('workspace-write', write(INSIDE)), 'allow')
check('workspace-write write outside asks', await verdict('workspace-write', write(OUTSIDE)), 'deny')
check('workspace-write asked once', askCount, 1)
check('workspace-write dialog header', lastDialog?.header, '请求修改授权')
check('write dialog grant label', lastDialog?.options[2].label, '该对话中总是可以修改')

// 完全访问: everything, silently.
check('full read outside', await verdict('danger-full-access', read(OUTSIDE)), 'allow')
check('full write outside', await verdict('danger-full-access', write(OUTSIDE)), 'allow')
check('full opens no dialog', askCount, 0)

// An unmapped preset falls back to `defaultLevel`, which grants nothing.
check('unknown preset read inside', await verdict('mystery-preset', read(INSIDE)), 'deny')
check('unknown preset write inside', await verdict('mystery-preset', write(INSIDE)), 'deny')
check('unknown preset opens no dialog', askCount, 0)

/* ------------------------------------------------------------ dialog --- */

dialogAnswer = '不允许'
check('dialog answer 不允许 denies', await verdict('workspace-access', read(OUTSIDE)), 'deny')
dialogAnswer = '仅一次'
check('dialog answer 仅一次 allows once', await verdict('workspace-access', read(OUTSIDE)), 'allow')
check('仅一次 asks again next time', await verdict('workspace-access', read(OUTSIDE)), 'allow')
check('仅一次 asked twice', askCount, 1)
dialogAnswer = '该对话中总是可以访问'
check('dialog answer 总是 allows', await verdict('workspace-access', read(OUTSIDE)), 'allow')
check('总是 does not ask again', await verdict('workspace-access', read(OUTSIDE)), 'allow')
check('总是 asked only once', askCount, 0)
// The answer is recorded as the directory that holds the path, never as a
// family: the list names it with a trailing separator, another file below it is
// covered, another directory still asks, and the level still rules.
const alwaysList = commands.get('access-allow').handler({ agent, rawInput: 'list' })?.text ?? ''
check('总是 records the directory in the extra list', alwaysList.includes('/opt/（读'), true)
check('a file below the granted directory is covered', await verdict('workspace-access', read('/opt/another.txt')), 'allow')
// Another directory was not part of the answer: it asks and can be refused.
dialogAnswer = '不允许'
askCount = 0
check('another directory still asks', await verdict('workspace-access', read(OTHER_OUTSIDE)), 'deny')
check('the other directory dialog was asked', askCount > 0, true)
// The `/opt` grant would hide every later `/opt` question, so it is taken back
// before the rest of the suite runs.
check('the directory grant is revoked', commands.get('access-allow').handler({ agent, rawInput: 'remove-read /opt' })?.kind, 'success')
askCount = 0
// The read grant must not leak into the write family: writing under a directory
// that a read grant covers still asks on the write side.
const READ_GRANT_DIR = '/opt/ap-read-grant'
check('read grant for the write-leak test', commands.get('access-allow').handler({ agent, rawInput: `add ${READ_GRANT_DIR}` })?.kind, 'success')
dialogAnswer = '不允许'
check('read grant does not grant writes', await verdict('workspace-access', write(`${READ_GRANT_DIR}/x.txt`)), 'deny')
check('the write side asked on its own', askCount, 1)
check('the write-leak read grant is taken back', commands.get('access-allow').handler({ agent, rawInput: `remove-read ${READ_GRANT_DIR}` })?.kind, 'success')
dialogAnswer = '不允许'

/* --------------------------------------------------------- allowlist --- */

const allow = commands.get('access-allow')
if (allow === undefined) throw new Error('plugin registered no /access-allow command')
const invoke = (rawInput) => allow.handler({ agent, rawInput })

// The level's name travels from the preset table through the level table into the
// status the user reads, so check the name where the user actually sees it.
currentPreset = 'workspace-access'
check('the level list names the read-and-write level', (invoke('list')?.text ?? '').includes('当前级别：工作区内读写'), true)
currentPreset = 'workspace-write'
check('the level list names the edit level', (invoke('list')?.text ?? '').includes('当前级别：工作区内编辑'), true)
currentPreset = 'danger-full-access'

check(
  'allowlist add', invoke(`add ${OUTSIDE}`)?.kind, 'success',
)
check('allowlist admits an outside read', await verdict('no-access', read(OUTSIDE)), 'allow')
check('allowlist opens no dialog', askCount, 0)
check('allowlist does not admit writes', await verdict('no-access', write(OUTSIDE)), 'deny')
check('allowlist does not admit other paths', await verdict('no-access', read(OTHER_OUTSIDE)), 'deny')
// One box per family. Reads are gated at `workspace-access` and writes only at
// `workspace-write`, so each side is revoked at the level that actually asks; the
// directory is granted on both sides first, or removing one side would be invisible.
const REMOVAL_DIR = '/opt/ap-removal'
dialogAnswer = '该对话中总是可以修改'
check('write grant for the removal test', await verdict('workspace-write', write(`${REMOVAL_DIR}/x.txt`)), 'allow')
dialogAnswer = '该对话中总是可以访问'
check('read grant for the removal test', await verdict('workspace-access', read(`${REMOVAL_DIR}/y.txt`)), 'allow')
check('both families are listed before the removal', (invoke('list')?.text ?? '').includes(`${REMOVAL_DIR}/（读+写`), true)
dialogAnswer = '不允许'
// A write carries its read, so the read box's ✕ takes the whole row away: both
// sides must ask again afterwards.
check('remove-read', invoke(`remove-read ${REMOVAL_DIR}`)?.kind, 'success')
check('the entry is gone from the list', (invoke('list')?.text ?? '').includes(REMOVAL_DIR), false)
check('the read side asks again', await verdict('workspace-access', read(`${REMOVAL_DIR}/z.txt`)), 'deny')
check('the write side asks again after remove-read', await verdict('workspace-write', write(`${REMOVAL_DIR}/z.txt`)), 'deny')
// The write box's own ✕ drops only the write half: give the row a read half of
// its own first (adding it while a write exists is refused by design, since the
// write already implies the read), then grant the write and remove only it.
check('explicit read half for remove-write', invoke(`add ${REMOVAL_DIR}/`)?.kind, 'success')
check('the explicit read admits without a dialog', await verdict('workspace-access', read(`${REMOVAL_DIR}/z.txt`)), 'allow')
dialogAnswer = '该对话中总是可以修改'
check('write grant again for remove-write', await verdict('workspace-write', write(`${REMOVAL_DIR}/x.txt`)), 'allow')
check('both families are listed before remove-write', (invoke('list')?.text ?? '').includes(`${REMOVAL_DIR}/（读+写`), true)
dialogAnswer = '不允许'
check('remove-write', invoke(`remove-write ${REMOVAL_DIR}`)?.kind, 'success')
const afterRemoveWrite = invoke('list')?.text ?? ''
check('the read half survives remove-write', afterRemoveWrite.includes(`${REMOVAL_DIR}/（读`) && !afterRemoveWrite.includes(`${REMOVAL_DIR}/（读+写`), true)
check('the write side asks after remove-write', await verdict('workspace-write', write(`${REMOVAL_DIR}/z.txt`)), 'deny')
check('the read side still passes without a dialog', await verdict('workspace-access', read(`${REMOVAL_DIR}/z.txt`)), 'allow')
check('remove-read cleans the remaining half', invoke(`remove-read ${REMOVAL_DIR}`)?.kind, 'success')
check('the removal test left nothing behind', (invoke('list')?.text ?? '').includes(REMOVAL_DIR), false)
// Under no-access even a workspace-internal read is refused, so that verdict is
// the proof the level actually came back.
check('the level is restored to no-access', await verdict('no-access', read(INSIDE)), 'deny')
invoke(`add ${OUTSIDE}`)
// A write entry can also be added by hand (`add-write`), which is what the write
// box's own buttons call.
check('add-write', invoke(`add-write ${OTHER_OUTSIDE}`)?.kind, 'success')
check('the hand-added path is listed as writable', (invoke('list')?.text ?? '').includes(`${OTHER_OUTSIDE}（读+写`), true)
check('the write side passes without a dialog', await verdict('workspace-write', write(OTHER_OUTSIDE)), 'allow')
const beforeImplied = askCount
check('add-write also grants reads', await verdict('workspace-access', read(OTHER_OUTSIDE)), 'allow')
check('the implied read opens no dialog', askCount, beforeImplied)
check('remove-write cleans the hand-added path', invoke(`remove-write ${OTHER_OUTSIDE}`)?.kind, 'success')
check('the implied read is gone after remove-write', await verdict('workspace-access', read(OTHER_OUTSIDE)), 'deny')
// Under no-access even a workspace-internal read is refused: the proof the level
// came back before the status assertions below.
check('the level is restored again', await verdict('no-access', read(INSIDE)), 'deny')
const listText = invoke('list')?.text ?? ''
check('allowlist status names the level', listText.includes('当前级别：无权限'), true)
check('allowlist status names the scopes', listText.includes('读取 none') && listText.includes('修改 none'), true)
check('allowlist status lists the running presets', listText.includes('no-access'), true)
check('allowlist remove', invoke(`remove ${OUTSIDE}`)?.kind, 'success')
check('removed entry is fenced again', await verdict('no-access', read(OUTSIDE)), 'deny')

/* ------------------------------------------ path decisions (shell) --- */

// What this section locks down: a shell command is judged by the paths it
// really names, never by its shape. Every shape below used to be refused
// wholesale because it contained a pipe, a redirect, a loop, a variable
// assignment, an in-place flag, or a heredoc.
dialogAnswer = '不允许'

const PIPE_INSIDE = `grep -rn foo ${ROOT} | head -20`
const PIPELINE_INSIDE = `cat ${ROOT}/a.txt | sort | uniq -c > ${ROOT}/b.txt`
const LOOP_INSIDE = 'for f in a.txt b.txt; do wc -l $f; done'
const LOOP_OUTSIDE = `for f in ${ROOT}/a.txt ${OTHER_OUTSIDE}; do cat $f; done`
const HEREDOC_INSIDE = `cat > ${ROOT}/note.md <<'EOF'\n中文内容\nEOF`
const HEREDOC_OUTSIDE = "cat > /opt/note.md <<'EOF'\n中文内容\nEOF"

check('pipe inside', await verdict('workspace-write', shell(PIPE_INSIDE)), 'allow')
check('pipe opens no dialog', askCount, 0)
check('pipe inside at read-only', await verdict('read-only', shell(PIPE_INSIDE)), 'allow')
check('redirect to /dev/null at read-only', await verdict('read-only', shell('node build.mjs 2>/dev/null')), 'allow')
check('redirect opens no dialog', askCount, 0)
check('redirect to /dev/null at workspace-write', await verdict('workspace-write', shell(`cat ${ROOT}/a.txt > /dev/null`)), 'allow')
check('loop over inside files', await verdict('workspace-write', shell(LOOP_INSIDE)), 'allow')
check('loop opens no dialog', askCount, 0)
check('assignment prefix', await verdict('read-only', shell('FOO=1 node build.mjs')), 'allow')
check('in-place edit inside', await verdict('workspace-write', shell(`sed -i s/a/b/ ${ROOT}/a.txt`)), 'allow')
check('in-place edit opens no dialog', askCount, 0)
check('heredoc writing inside', await verdict('workspace-write', shell(HEREDOC_INSIDE)), 'allow')
check('heredoc opens no dialog', askCount, 0)
const pythonInWorkspace = (separator, path) => [
  `cd '${ROOT}/sub'${separator}python3 - <<'PY'`,
  `p = '${path}'`,
  "s = open(p, encoding='utf8').read()",
  'PY',
  'cd /opt',
].join('\n')
const guardedPython = pythonInWorkspace(' && ', 'paper-source.md')
check('guarded Python heredoc resolves its relative target at invocation',
  analyzeShell(guardedPython).readPaths, [`${ROOT}/sub/paper-source.md`])
check('guarded Python heredoc does not use outside workdir as its base',
  await verdict('workspace-access', ['bash', { command: guardedPython, workdir: '/opt' }]), 'allow')
check('guarded Python heredoc opens no dialog', askCount, 0)
const unguardedPython = pythonInWorkspace('\n', 'paper-source.md')
check('unguarded Python heredoc retains the cd failure directory',
  analyzeShell(unguardedPython).readPaths, [`${ROOT}/sub/paper-source.md`, 'paper-source.md'])
check('unguarded Python heredoc asks from an outside workdir',
  await verdict('workspace-access', ['bash', { command: unguardedPython, workdir: '/opt' }]), 'deny')
check('unguarded Python heredoc names the possible outside target', lastDialog?.detail.includes('/opt/paper-source.md'), true)
askCount = 0

// Only access results should leave the child; its directory and variables do not.
for (const child of [
  `bash -c 'cd /opt && X=child.txt && cat "$X"'`,
  `$(cd /opt && X=child.txt && cat "$X")`,
  `(cd /opt && X=child.txt && cat "$X")`,
]) {
  const command = `X=parent.txt; ${child}; cat "$X"`
  check('child access is retained without exporting its environment',
    analyzeShell(command).readPaths, ['/opt/child.txt', 'parent.txt'])
}
check('child cwd does not create a false outside dialog',
  await verdict('workspace-access', shell("bash -c 'cd /opt'; cat local.txt")), 'allow')
check('child cwd does not create a dialog', askCount, 0)
check('child reading an outside file still requests authorization',
  await verdict('workspace-access', shell("bash -c 'cd /opt && cat child.txt'; cat local.txt")), 'deny')
check('child outside read is the path listed', lastDialog?.detail.includes('/opt/child.txt'), true)
askCount = 0

check('OR reads from the incoming cwd on cd failure',
  analyzeShell('cd /opt || cat local.txt').readPaths, ['local.txt'])
check('a later unconditional command considers both cd results',
  analyzeShell('cd /opt; cat local.txt').readPaths, ['/opt/local.txt', 'local.txt'])
check('AND/OR chains carry distinct cwd states',
  analyzeShell('cd /opt && cat good.txt || cat fallback.txt').readPaths,
  ['/opt/good.txt', '/opt/fallback.txt', 'fallback.txt'])
check('pipeline stages do not export their cwd',
  analyzeShell('cd /opt | cat piped.txt; cat local.txt').readPaths, ['piped.txt', 'local.txt'])
check('a grouped pipeline stage can change its own directory',
  analyzeShell('printf data | (cd /opt && cat piped.txt); cat local.txt').readPaths, ['/opt/piped.txt', 'local.txt'])
check('redirect operands use the cwd of their command branch',
  analyzeShell('cd /opt || cat < fallback').readPaths, ['fallback'])
const unknownDirectoryRead = 'cd "$UNSPECIFIED" && cat local.txt'
check('unknown cd does not substitute a known relative target',
  analyzeShell(unknownDirectoryRead).uncertainFamilies, ['read'])
check('unknown relative read is refused under the default workspace policy',
  await verdict('workspace-access', shell(unknownDirectoryRead)), 'deny')
check('unknown relative read does not ask for a guessed directory grant', askCount, 0)
check('an absolute operand stays determinate after an unknown cd',
  analyzeShell(`cd "$UNSPECIFIED" && cat '${INSIDE}'`).readPaths, [INSIDE])

const movingScript = `python3 -c "import os; os.chdir('/opt'); open('relative.txt'); open('${OUTSIDE}')"`
const dynamicScript = `node -e "require('fs').readFileSync(process.env.INPUT_FILE)"`
for (const [command, reason] of [[movingScript, 'script-cwd-change'], [dynamicScript, 'dynamic-script-path']]) {
  const result = analyzeShell(command)
  check('interpreted runtime paths are explicitly uncertain', result.uncertainFamilies, ['read', 'write'])
  check('runtime path uncertainty has a specific cause', result.reason.includes(reason), true)
  const blocked = await run('workspace-access', ...shell(command))
  check('workspace scope refuses targets it cannot bound', blocked.kind, 'deny')
  check('runtime path refusal explains the uncertainty', blocked.reason.includes('无法确定'), true)
  check('unknown targets do not create a directory authorization', askCount, 0)
}
check('absolute script targets are retained', analyzeShell(movingScript).readPaths.includes(OUTSIDE), true)
check('relative script targets after chdir are not tied to invocation cwd',
  analyzeShell(movingScript).readPaths.some((path) => path.endsWith('relative.txt')), false)
check('Python heredoc still asks about an explicit outside path',
  await verdict('workspace-access', shell(pythonInWorkspace(' && ', OUTSIDE))), 'deny')
check('outside Python heredoc opens a dialog', askCount, 1)
check('quoted heredoc syntax does not hide the following command',
  analyzeShell(`echo '<<EOF'\ncat ${OUTSIDE}`).readPaths, [OUTSIDE])
check('pipeline writing inside', await verdict('workspace-write', shell(PIPELINE_INSIDE)), 'allow')
check('removing a workspace path', await verdict('workspace-write', shell(`rm -rf ${ROOT}/sub`)), 'allow')
check('removing a workspace path opens no dialog', askCount, 0)
check('find -delete inside', await verdict('workspace-write', shell(`find ${ROOT} -name '*.tmp' -delete`)), 'allow')
check('find -delete inside opens no dialog', askCount, 0)

// The same shapes are still fenced when the real path leaves the workspace.
check('pipe reading outside asks', await verdict('workspace-access', shell('grep -rn foo /etc | head -5')), 'deny')
check('pipe outside asked once', askCount, 1)
check('pipe outside dialog names the path', lastDialog?.detail.includes('/etc'), true)
check('loop with an outside element asks', await verdict('workspace-access', shell(LOOP_OUTSIDE)), 'deny')
check('loop outside dialog names the element', lastDialog?.detail.includes(OTHER_OUTSIDE), true)
check('in-place edit outside asks', await verdict('workspace-write', shell(`sed -i s/a/b/ ${OUTSIDE}`)), 'deny')
check('in-place edit outside asked once', askCount, 1)
check('heredoc writing outside asks', await verdict('workspace-write', shell(HEREDOC_OUTSIDE)), 'deny')
check('cd then write outside asks', await verdict('workspace-write', shell('cd /opt && rm -f victim.txt')), 'deny')
check('find -delete outside asks', await verdict('workspace-write', shell("find /opt -name '*.tmp' -delete")), 'deny')
check('mv inside to outside asks', await verdict('workspace-write', shell(`mv ${ROOT}/a.txt /opt/b.txt`)), 'deny')
check('unknown target is a modification', await verdict('read-only', shell('rm -rf $TARGET')), 'deny')
check('unknown target opens no dialog', askCount, 0)

// An opaque program's own text no longer names its targets, so it is judged by
// the directory it runs in: inside the workspace it passes, from an outside
// directory the user is asked about that directory, and the answer is kept for it.
const opaque = await run('workspace-access', ...shell('node build.mjs'))
check('opaque script at workspace-access', opaque?.kind, 'allow')
check('opaque script opens no dialog', askCount, 0)
check('opaque script runs the next handler', opaque?.via, 'next')
check('opaque script at read-only', await verdict('read-only', shell('node build.mjs')), 'allow')
check('opaque script at workspace-write', await verdict('workspace-write', shell('node build.mjs')), 'allow')
check('opaque script at workspace-write opens no dialog', askCount, 0)
dialogAnswer = '该对话中总是可以访问'
askCount = 0
check('an opaque script from an outside directory asks and is allowed', await verdict('workspace-access', shell('cd /opt && node build.mjs')), 'allow')
check('opaque dialog does not present an exhaustive target list', lastDialog?.detail.includes('不代表完整的访问清单'), true)
check('the outside directory was asked about', askCount, 1)
check('the dialog names the directory', lastDialog?.detail.includes('/opt'), true)
check('the answer records the directory', (commands.get('access-allow').handler({ agent, rawInput: 'list' })?.text ?? '').includes('/opt/（读'), true)
askCount = 0
check('the same directory needs no new question', await verdict('workspace-access', shell('cd /opt && node build.mjs')), 'allow')
check('the covered directory opened no dialog', askCount, 0)
check('a subdirectory of it is covered too', await verdict('workspace-access', shell('cd /opt/sub && node build.mjs')), 'allow')
// The directory grant would hide every later `/opt` question, so it is taken
// back before the rest of the suite runs.
check('the opaque grant is revoked', invoke('remove-read /opt')?.kind, 'success')
dialogAnswer = '不允许'

// The switch keeps the old rule available: with `opaquePolicy: 'deny'` an
// unreadable command at `workspace-access` is refused instead of judged by the
// directory it runs in. The policy is config, so this needs its own instance;
// only the gate is captured, the other registrations are dropped.
let strictGate
const strictCtx = Object.create(ctx)
strictCtx.on = (name, handler) => {
  if (name === 'tools/pre-execute') strictGate = handler
  return () => {}
}
strictCtx.commands = { register: () => () => {} }
strictCtx.systemPrompt = { section: () => () => {} }
apply(strictCtx, { levels, defaultLevel, treatReadOnlyAsNoAccess: treatReadOnly === 'true', opaquePolicy: 'deny' })
currentPreset = 'workspace-access'
const strictOpaque = await strictGate({ agent, name: 'bash', arguments: { command: 'node build.mjs' } }, next)
check('opaquePolicy deny keeps the old refusal', strictOpaque?.kind, 'deny')
check('opaquePolicy deny explains the unknown paths', String(strictOpaque?.reason).includes('无法确定'), true)

/* ---------------------------------- directory grants (points 2 and 3) --- */

// Point 3: inside the workspace a writable level writes without a question,
// subdirectories and their files included.
askCount = 0
check('a recursive removal inside the workspace', await verdict('workspace-write', shell(`rm -rf ${ROOT}/sub`)), 'allow')
check('the inside removal opens no dialog', askCount, 0)
check('mkdir -p inside the workspace', await verdict('workspace-write', shell(`mkdir -p ${ROOT}/a/b/c`)), 'allow')
check('a script in the workspace at workspace-write', await verdict('workspace-write', shell(`cd ${ROOT} && node build.mjs`)), 'allow')
check('the inside script opens no dialog', askCount, 0)
// Point 2: one answer about an outside directory covers the whole tree below
// it — deeper files, subdirectories, and in-place rewrites.
const BUILD = '/opt/build'
dialogAnswer = '该对话中总是可以修改'
askCount = 0
check('a recursive removal of an outside directory asks once', await verdict('workspace-write', shell(`rm -r ${BUILD}`)), 'allow')
check('the outside removal asked once', askCount, 1)
check('the answer records the removed directory', (invoke('list')?.text ?? '').includes(`${BUILD}/（读+写`), true)
const grantedTree = [
  ['a deeper file', `rm -rf ${BUILD}/dist/old.js`],
  ['a subdirectory', `rmdir ${BUILD}/dist`],
  ['an in-place rewrite', `sed -i s/a/b/ ${BUILD}/dist/app.js`],
]
for (const [name, command] of grantedTree) {
  askCount = 0
  check(`${name} is covered by the granted directory`, await verdict('workspace-write', shell(command)), 'allow')
  check(`${name} opens no dialog`, askCount, 0)
}
dialogAnswer = '不允许'
askCount = 0
check('a sibling directory still asks', await verdict('workspace-write', shell('rm -rf /opt/build2')), 'deny')
check('the sibling asked once', askCount, 1)

// A mixed command is asked about exactly its outside half, and the write half is
// the one that gets the dialog.
dialogAnswer = '仅一次'
const mixed = await run('workspace-write', ...shell(`cat ${ROOT}/a.txt > ${OUTSIDE}`))
check('mixed command is allowed once', mixed?.kind, 'allow')
check('mixed command asked once', askCount, 1)
check('mixed command asked about the write', lastDialog?.header, '请求修改授权')
check('mixed command dialog names the outside path', lastDialog?.detail.includes(OUTSIDE), true)
dialogAnswer = '不允许'

/* ------------------------------------------------------------ prompt --- */

const section = handlers.get('agent/created')
check('plugin subscribes to agent/created', typeof section, 'function')

/* ------------------------------------------- typed path recognition --- */

// The typed-path reader is pure, so the shapes a user may type are pinned
// directly instead of round-tripping through the command.
const norm = (raw, options = {}) => normalizeUserPath(raw, { root: ROOT, home: TEST_HOME, ...options })
const HOME_DIR = homedir()

// What a WSL host sees: each Windows drive is a 9p mount whose source is the
// drive root (`C:\134`), which is exactly the table the plugin reads.
const HOST_MOUNTS = (() => {
  const out = {}
  try {
    for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const fields = line.split(' ')
      const drive = /^([A-Za-z]):\\134$/.exec(fields[0])
      if (drive !== null && typeof fields[1] === 'string' && fields[1].startsWith('/')) out[drive[1].toUpperCase()] = fields[1]
    }
  } catch { /* not linux */ }
  return out
})()
const HOST_DRIVE = Object.keys(HOST_MOUNTS)[0]
const MOUNTS = { C: '/mnt/c', D: '/mnt/d', E: '/mnt/e' }

check('double quotes are stripped', norm('"/etc/hosts"')?.path, '/etc/hosts')
check('single quotes are stripped', norm("'/etc/hosts'")?.path, '/etc/hosts')
check('backticks are stripped', norm('`/etc/hosts`')?.path, '/etc/hosts')
check('corner brackets are stripped', norm('「/etc/hosts」')?.path, '/etc/hosts')
check('a doubled quote pair is stripped', norm('"\'\'/etc/hosts\'\'"')?.path, '/etc/hosts')
check('an escaped space is unescaped', norm('/opt/a\\ b')?.path, '/opt/a b')
check('a quoted trailing space is kept out of the name', norm('"/opt/sp ace/"')?.directory, true)
check('a file url is decoded', norm('file:///etc/hosts')?.path, '/etc/hosts')
check('a percent-encoded file url is decoded', norm('file:///home/user/a%20b')?.path, `${TEST_HOME}/a b`)
check('tilde alone is the home directory', norm('~')?.path, TEST_HOME)
check('tilde prefix is the home directory', norm('~/x')?.path, `${TEST_HOME}/x`)
check('another user\'s tilde is refused', norm('~root/x')?.reason, 'unknown-user')
check('$HOME is expanded', norm('$HOME/x')?.path, `${TEST_HOME}/x`)
check('${HOME} is expanded', norm('${HOME}/y')?.path, `${TEST_HOME}/y`)
check('a relative path hangs off the workspace root', norm('a/b')?.path, `${ROOT}/a/b`)
check('dot-dot climbs out of the workspace root', norm('../x')?.path, join(dirname(ROOT), 'x'))
check('dots and empty segments are folded', norm('/opt//a/./b/../c')?.path, '/opt/a/c')
check('a trailing separator marks a directory', norm('/opt/x/')?.directory, true)
check('a bare dot is the workspace root', norm('.')?.path, ROOT)
check('a bare dot is a directory', norm('.')?.directory, true)
check('an empty path is refused', norm('   ')?.reason, 'empty')
check('a nul byte is refused', norm('/opt/a\u0000b')?.reason, 'nul')
check('a windows path is kept', norm('C:\\tmp\\a', { windows: true })?.path, 'C:\\tmp\\a')
check('a windows relative path hangs off the root', norm('sub\\file.txt', { windows: true, root: 'C:\\ap-test' })?.path, 'C:\\ap-test\\sub\\file.txt')
check('a UNC path keeps its double backslash', norm('\\\\server\\share\\x', { windows: true })?.path, '\\\\server\\share\\x')
check('a windows drive path maps to its wsl mount', norm('C:\\Users\\me', { windowsMounts: MOUNTS })?.path, '/mnt/c/Users/me')
check('the drive mapping is marked as such', norm('C:\\Users\\me', { windowsMounts: MOUNTS })?.mapped, true)
check('the drive letter case does not matter', norm('c:/Users/me', { windowsMounts: MOUNTS })?.path, '/mnt/c/Users/me')
check('a bare drive names the mount point', norm('D:', { windowsMounts: MOUNTS })?.path, '/mnt/d')
check('a bare drive is a directory', norm('D:', { windowsMounts: MOUNTS })?.directory, true)
check('a trailing separator stays a directory hint', norm('E:\\data\\', { windowsMounts: MOUNTS })?.directory, true)
check('dot-dot folds under the mount point', norm('C:\\a\\..\\b', { windowsMounts: MOUNTS })?.path, '/mnt/c/b')
check('a quoted drive path maps too', norm('"C:\\Program Files"', { windowsMounts: MOUNTS })?.path, '/mnt/c/Program Files')
check('a file url with a drive letter maps', norm('file:///C:/x', { windowsMounts: MOUNTS })?.path, '/mnt/c/x')
check('an unmounted drive stays a windows path', norm('Z:\\nope', { windowsMounts: MOUNTS })?.path, 'Z:\\nope')
check('a UNC path is not taken for a drive', norm('\\\\server\\share\\x', { windowsMounts: MOUNTS })?.mapped, undefined)
check('without a mount table a drive path is unchanged', norm('C:\\Users\\me')?.path, 'C:\\Users\\me')
check('on a native windows host nothing is remapped', norm('C:\\Users\\me', { windows: true, windowsMounts: MOUNTS })?.path, 'C:\\Users\\me')

// The command accepts those same shapes, records the canonical path, and says
// out loud when the target does not exist yet.
check('quoted path through the command', invoke('add "/etc/hosts"')?.kind, 'success')
check('the quoted path is listed', (invoke('list')?.text ?? '').includes('/etc/hosts'), true)
check('single-quoted path through the command', invoke("add '/opt/ap-file.txt'")?.kind, 'success')
check('the single-quoted path is listed', (invoke('list')?.text ?? '').includes('/opt/ap-file.txt'), true)
check('file url through the command', invoke('add file:///opt/ap-url.txt')?.kind, 'success')
check('the file url is listed as a path', (invoke('list')?.text ?? '').includes('/opt/ap-url.txt'), true)
check('tilde path through the command', invoke('add ~/ap-home.txt')?.kind, 'success')
check(`the tilde path is listed as ${HOME_DIR}/ap-home.txt`, (invoke('list')?.text ?? '').includes(`${HOME_DIR}/ap-home.txt`), true)
check('relative path through the command', invoke('add ap-relative.txt')?.kind, 'success')
check('the relative path is listed against the workspace root', (invoke('list')?.text ?? '').includes(`${ROOT}/ap-relative.txt`), true)
check('folded path through the command', invoke('add /opt//ap/./x/../y')?.kind, 'success')
check('the folded path is listed', (invoke('list')?.text ?? '').includes('/opt/ap/y'), true)
check('an existing directory through the command', invoke('add "/etc/"')?.kind, 'success')
check('the existing directory is listed with a trailing separator', (invoke('list')?.text ?? '').includes('/etc/'), true)
const missing = invoke('add "/opt/ap-not-there/"')
check('a missing path is still allowed', missing?.kind, 'success')
check('the missing path is named in the answer', missing?.text.includes('当前不存在'), true)
check('the missing path is listed', (invoke('list')?.text ?? '').includes('/opt/ap-not-there/'), true)
check('an unknown user is refused', invoke('add "~root/x"')?.kind, 'error')
check('the refusal explains the tilde form', (invoke('add "~root/x"')?.text ?? '').includes('不支持'), true)
check('an empty argument is refused', invoke('add')?.kind, 'error')

// The command shares the same typed-path reader, and the host supplies the real
// mount table, so a drive path typed into the box ends up as the mounted path
// the tools can open. The machine under test decides which drive exists.
if (HOST_DRIVE !== undefined) {
  const mount = HOST_MOUNTS[HOST_DRIVE].replace(/\/+$/, '')
  const readReply = invoke('add "' + HOST_DRIVE + ':\\ap-win-test\\"')
  check('a mounted drive path is accepted', readReply?.kind, 'success')
  check('the mapped path is listed', (invoke('list')?.text ?? '').includes(mount + '/ap-win-test/'), true)
  check('the answer says the path was mapped', (readReply?.text ?? '').includes('Windows 盘符'), true)
  const writeReply = invoke('add-write "' + HOST_DRIVE + ':\\ap-win-write"')
  check('a mounted drive path is accepted for writing too', writeReply?.kind, 'success')
  check('the write row stores the mapped path', (invoke('list')?.text ?? '').includes(mount + '/ap-win-write'), true)
} else {
  check('without mounted drives a drive path is not remapped', (invoke('add "C:\\ap-win-test"')?.text ?? '').includes('Windows 盘符'), false)
}

// Removal reads a typed path the same way: a quoted, home-prefixed or
// drive-spelled argument names the row that `add` stored.
check('a quoted path is added before removal', invoke('add "/opt/ap-quoted-remove.txt"')?.kind, 'success')
check('a quoted path removes its row', invoke('remove "/opt/ap-quoted-remove.txt"')?.kind, 'success')
check('the quoted row is gone', (invoke('list')?.text ?? '').includes('/opt/ap-quoted-remove.txt'), false)
check('a tilde path is added before removal', invoke('add ~/ap-home-remove.txt')?.kind, 'success')
check(`a tilde path removes ${HOME_DIR}/ap-home-remove.txt`, invoke('remove ~/ap-home-remove.txt')?.kind, 'success')
check('the tilde row is gone', (invoke('list')?.text ?? '').includes(`${HOME_DIR}/ap-home-remove.txt`), false)
if (HOST_DRIVE !== undefined) {
  const mount = HOST_MOUNTS[HOST_DRIVE].replace(/\/+$/, '')
  const drive = HOST_DRIVE + ':\\ap-win-remove\\'
  check('a drive path is added before removal', invoke('add "' + drive + '"')?.kind, 'success')
  check('a drive path removes the mapped row', invoke('remove "' + drive + '"')?.kind, 'success')
  check('the mapped row is gone', (invoke('list')?.text ?? '').includes(mount + '/ap-win-remove'), false)
}

/* --------------------------------------- release-review regressions --- */

// Earlier checks add read allowlist rows, and an allowlisted read outranks the
// level; the ladder-shaped findings below need a clean list.
invoke('clear')

// Every assertion below is one finding of the pre-release review, reproduced
// before the fix. They stay here so the hole cannot reopen silently.

// Path shapes the lexical test used to drop: a bare file name, an implicit
// search root, a nested tool argument, a variable, `dd if=`, `file://`, and a
// copy whose source was mistaken for its destination.
check('no-access denies a bare file name', await verdict('no-access', shell('cat secret')), 'deny')
check('no-access denies glob without a path', await verdict('no-access', ['glob', {}]), 'deny')
check('no-access denies grep without a path', await verdict('no-access', ['grep', { pattern: 'secret' }]), 'deny')
check('no-access denies a nested tool path', await verdict('no-access', ['present', { files: [{ path: OUTSIDE }] }]), 'deny')
check('no-access denies a file url read', await verdict('no-access', shell('curl file:///etc/passwd')), 'deny')
check('no-access denies a read through a variable', await verdict('no-access', shell('X=/etc/passwd; cat "$X"')), 'deny')
check('no-access denies dd input', await verdict('no-access', shell('dd if=/etc/passwd of=/dev/null')), 'deny')
check('no-access denies a copy source', await verdict('no-access', shell('cp /etc/passwd out')), 'deny')

const analyzer = (command) => analyzeShell(command, { root: ROOT })
check('a bare operand is a read path', analyzer('cat secret').readPaths.length > 0, true)
check('a variable expands to its value', analyzer('X=/etc/passwd; cat "$X"').readPaths, ['/etc/passwd'])
check('dd input is a read path', analyzer('dd if=/etc/passwd of=/dev/null').readPaths, ['/etc/passwd'])
check('a copy source is read, not written', [analyzer('cp /etc/passwd out').readPaths, analyzer('cp /etc/passwd out').writePaths], [['/etc/passwd'], ['out']])
check('a file url resolves to its path', analyzer('curl file:///etc/passwd').readPaths, ['/etc/passwd'])

// A relative path in an outside working directory is not a temp path.
check('an outside workdir relative read asks', await verdict('workspace-access', ['bash', { command: 'cat ./secret.txt', workdir: '/opt/private' }]), 'deny')
check('the outside workdir relative read was asked', askCount, 1)
check('shell dialog lists the resolved target, not just the command', lastDialog?.detail.includes('\n\n    /opt/private/secret.txt\n'), true)
check('shell dialog names the actual starting base', lastDialog?.detail.includes('**相对路径的起始基准**（命令内部可能改变目录）\n\n    /opt/private\n'), true)
check('shell dialog retains a literal command preview', lastDialog?.detail.includes('**命令预览**\n\n    cat ./secret.txt'), true)
check('a relative path does not resolve against the temp root', await verdict('workspace-access', ['bash', { command: 'cat ../../etc/hosts', workdir: '/opt/private' }]), 'deny')

// A symlink inside the workspace that points outside it must not read as inside.
const linkPath = `${ROOT}/ap-escape-link`
try { mkdirSync(ROOT, { recursive: true }) } catch {}
try { unlinkSync(linkPath) } catch {}
try {
  symlinkSync('/etc', linkPath)
  check('a symlink escape read is denied', await verdict('workspace-access', read(`${linkPath}/hosts`)), 'deny')
  check('a symlink escape write is denied', await verdict('workspace-write', write(`${linkPath}/ap-escape.txt`)), 'deny')
} finally {
  try { unlinkSync(linkPath) } catch {}
}

// Removing a grant the log replayed used to throw, and the removal used to be
// undone by the next cache rebuild (a re-attached agent does exactly that).
dialogAnswer = '该对话中总是可以访问'
const grantRows = () => invoke('list')?.text ?? ''
const grantedPath = `${ROOT}/../ap-grant-src/file.txt`
check('a standing read grant is recorded', await verdict('workspace-access', read(grantedPath)), 'allow')
check('the granted directory is listed', grantRows().includes('ap-grant-src'), true)
let removalText = ''
try { removalText = invoke(`remove ${ROOT}/../ap-grant-src`)?.text ?? '' } catch (cause) { removalText = `threw ${String(cause)}` }
check('removing a logged grant does not throw', removalText.includes('threw'), false)
check('the removed grant is gone', grantRows().includes('ap-grant-src'), false)
handlers.get('agent/disposed')({ agent })
check('a re-attached agent keeps the removal', grantRows().includes('ap-grant-src'), false)

// Removal and clear happen on the live cache, which is what the conversation
// reads from; a re-attached agent must not resurrect what was removed.
const grantedRow = () => grantRows().includes('ap-grant-src')
dialogAnswer = '该对话中总是可以访问'
check('a second grant is recorded', await verdict('workspace-access', read(`${ROOT}/../ap-grant-src/two.txt`)), 'allow')
check('the second grant is listed', grantedRow(), true)
check('clear removes the replayable row', invoke('clear')?.kind, 'success')
handlers.get('agent/disposed')({ agent })
check('clear survives a re-attached agent', grantedRow(), false)

// A delegated task runs inside the run that authorized the path, so it inherits
// the parent conversation's grants instead of asking again.
dialogAnswer = '该对话中总是可以访问'
check('the parent grant is recorded', await verdict('workspace-access', read(`${ROOT}/../ap-parent-grant/f.txt`)), 'allow')
const childSession = { id: 'sess-child', snapshotEvents: () => [], header: { origin: 'subagent', parentSession: session.id } }
// `liveSession` resolves the parent through the plugin's own session service.
const knownSessions = new Map([[session.id, session]])
ctx.get = (name) => (name === 'sessions' ? { get: (id) => knownSessions.get(id) } : undefined)
const parentAgent = agent
agent.session = childSession
dialogAnswer = '不允许'
check('a delegated task inherits the parent grant', await (async () => {
  currentPreset = 'workspace-access'
  askCount = 0
  const result = await gate({ agent, name: 'read', arguments: { file_path: `${ROOT}/../ap-parent-grant/g.txt` } }, next)
  return [result?.kind, askCount]
})(), ['allow', 0])
agent.session = parentAgent

// An answer that arrives after the user narrowed the level does not outlive it.
currentPreset = 'workspace-access'
dialogAnswer = '仅一次'
const narrowed = await (async () => {
  const answerer = ctx.userQuestions.ask
  ctx.userQuestions.ask = async (request) => {
    currentPreset = 'no-access'
    return answerer(request)
  }
  try {
    return await verdict('workspace-access', read(OTHER_OUTSIDE))
  } finally {
    ctx.userQuestions.ask = answerer
    currentPreset = 'workspace-access'
    dialogAnswer = '不允许'
  }
})()
check('an answer under a narrowed level is refused', narrowed, 'deny')

console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `${failures}/${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
