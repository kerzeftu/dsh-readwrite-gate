/**
 * Host half of the readwrite-gate bundle.
 *
 * It adds two access levels on top of the deployment's permission presets:
 * `none` (no file may be read or modified) and `workspace` (only paths inside
 * the session workspace may be read or modified). Reads and modifications are
 * gated separately: a path outside the workspace pauses the tool call and asks
 * the user, who may refuse, allow this one call, or allow that family for the
 * rest of the conversation.
 *
 * A per-conversation read allowlist can additionally admit specific files or
 * directories outside the workspace without a dialog. Adding to it is a
 * user-only action: it lives on the plain `/access-allow` command, never on the
 * model-facing side.
 *
 * @module dsh-readwrite-gate
 */
import { readFileSync, statSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { allowListOf, allowedBy, classifyPathForm, classifyTool, containsPath, directoryOf, foldPath, isLevel, normalizeUserPath, scopeBaseOf } from './functions.js'

/** Services this plugin cannot work without. */
export const inject = [
  'tools',
  'commands',
  'userQuestions',
  'permissionPresets',
  'sandboxPolicy',
]

/** Options for one `ctx.systemPrompt.section()` contribution. */
const PROMPT_ORDER = 60

/** The scope values one level entry may use for reads and writes. */
const SCOPES = ['anywhere', 'workspace', 'none']

/**
 * Windows drives mounted on this machine, keyed by upper-case drive letter.
 * Under WSL `/proc/mounts` lists them as `C:\134 /mnt/c 9p …` (the backslash is
 * escaped), which is how a typed `C:\Users\me` becomes the mounted path the
 * tools can actually open. Other platforms simply produce no entries.
 * @returns a plain object mapping `'C'` to `'/mnt/c'` and so on.
 */
function windowsMounts() {
  const mounts = Object.create(null)
  let table = ''
  try { table = readFileSync('/proc/mounts', 'utf8') } catch { return mounts }
  for (const line of table.split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 2) continue
    const drive = /^([A-Za-z]):\\134$/.exec(fields[0])
    if (drive === null) continue
    if (!fields[1].startsWith('/')) continue
    mounts[drive[1].toUpperCase()] = fields[1]
  }
  return mounts
}

/**
 * The platform temp area, which the plugin treats as inside the workspace.
 *
 * The shipped `workspace-write` sandbox already writes `/tmp` and `os.tmpdir()`
 * (`dsh-sandbox`'s writable roots), and scratch files are ordinary tooling
 * output, so asking about them would be a dialog the platform grants anyway.
 * Canonicalised because `/tmp` may itself be a symlink on some systems.
 * @returns the temp roots, de-duplicated, never empty on a normal machine.
 */
const WINDOWS_HOST = process.platform === 'win32'

const TEMP_AREA = (() => {
  const roots = []
  // `/tmp` is a POSIX root. On a native Windows host the literal word names
  // nothing, and accepting it would widen the platform's own temp allowance.
  const candidates = WINDOWS_HOST ? [tmpdir()] : ['/tmp', tmpdir()]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    let canonical = candidate
    try { canonical = realpathSync(candidate) } catch { canonical = candidate }
    for (const value of [candidate, canonical]) {
      if (value !== '' && !roots.includes(value)) roots.push(value)
    }
  }
  return roots
})()

/**
 * Whether a path lives in the platform temp area.
 *
 * Only an absolute path can be inside: a relative word has no home yet, and
 * reading it against the temp root made `./secret.txt` in an outside working
 * directory look like `/tmp/secret.txt`.
 * @param path - the absolute path to test.
 * @returns `true` when a temp root contains it.
 */
function insideTempArea(path) {
  if (typeof path !== 'string' || path === '') return false
  // Only a path that carries its own anchor can be inside: a relative word has
  // no home yet, and reading it against the temp root made `./secret.txt` in an
  // outside working directory look like `/tmp/secret.txt`.
  const form = classifyPathForm(path)
  if (form !== 'root' && form !== 'drive' && form !== 'unc') return false
  for (const root of TEMP_AREA) {
    try {
      if (containsPath(path, root, root).contained) return true
    } catch {
      // A malformed candidate simply fails to match.
    }
  }
  return false
}

/**
 * Resolve one path to an absolute path against the base relative words use.
 * @param path - a path the classifier recorded.
 * @param base - the directory relative paths resolve against.
 * @returns the absolute path, or `undefined` when the word cannot be placed.
 */
function absolutePathOf(path, base) {
  if (typeof path !== 'string' || path === '') return undefined
  // `~` is the shell's business; without expansion it names nothing this gate
  // can place, so it stays treated as outside.
  if (path.startsWith('~')) return undefined
  const windows = WINDOWS_HOST
    || classifyPathForm(path) === 'drive'
    || classifyPathForm(path) === 'unc'
    || /^[A-Za-z]:[\\/]/.test(typeof base === 'string' ? base : '')
    || (typeof base === 'string' && base.includes('\\'))
  const folded = foldPath(path, { windows, base: typeof base === 'string' ? base : undefined })
  // A device namespace or a drive-relative word names no placeable path; the
  // caller treats `undefined` as outside.
  return folded
}

/** How long one realpath answer is reused, so a moved symlink is noticed. */
const CANONICAL_TTL_MS = 2000

/** Real paths seen recently, so one tool call's symlink resolution is not repeated. */
const canonicalCache = new Map()

/**
 * The real path behind one absolute path, with every existing ancestor resolved.
 *
 * Containment on the lexical path is not the same as containment on disk: a
 * symlink inside the workspace that points outside it would otherwise read as
 * inside, and the read side has no platform fence behind it.
 * @param path - an absolute path, which may not exist yet.
 * @returns the canonical path, or the input when nothing resolves.
 */
function canonicalPathOf(path) {
  if (typeof path !== 'string' || path === '') return path
  const now = Date.now()
  const cached = canonicalCache.get(path)
  if (cached !== undefined && now - cached.at < CANONICAL_TTL_MS) return cached.value
  if (canonicalCache.size > 4096) canonicalCache.clear()
  let result = path
  try {
    result = realpathSync(path)
  } catch {
    // The longest existing ancestor is resolved instead: split on either
    // separator, because a native Windows path is written with backslashes.
    const boundary = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (boundary > 0) {
      const head = path.slice(0, boundary)
      const real = canonicalPathOf(head)
      if (real !== head) result = `${real}${path.slice(boundary)}`
    }
  }
  canonicalCache.set(path, { value: result, at: now })
  return result
}

/**
 * Read one configured scope, falling back when it is not a known value.
 * @param value - configured scope.
 * @param fallback - scope used when the value is unusable.
 * @returns the scope.
 */
const scopeOf = (value, fallback) => (SCOPES.includes(value) ? value : fallback)

/**
 * Normalize the row's configuration. The bundle deliberately exports no
 * `Config` schema — a plain workspace package cannot resolve the
 * `@deepseek-ai/schemastery` instance the deployment uses — so unreadable
 * values are defaulted here instead of being rejected at load.
 * @param raw - raw row configuration.
 * @returns the resolved configuration.
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    levels: config.levels !== null && typeof config.levels === 'object' ? config.levels : {},
    presetLevels: config.presetLevels !== null && typeof config.presetLevels === 'object' ? config.presetLevels : {},
    // Accepts a level-table key as well as a bare level value; anything else is
    // resolved to `none` further down, so a typo can only ever narrow access.
    defaultLevel: typeof config.defaultLevel === 'string' && config.defaultLevel !== '' ? config.defaultLevel : 'none',
    treatReadOnlyAsNoAccess: config.treatReadOnlyAsNoAccess !== false,
    // An opaque command (a script or an unknown program whose text no longer
    // names its targets) is judged by the directory it runs in, so a command
    // that stays inside the workspace passes instead of being refused. `deny`
    // restores the strict refusal for deployments that want it.
    opaquePolicy: config.opaquePolicy === 'deny' ? 'deny' : 'directory',
  }
}

/**
 * Render one extra path for display, with a trailing separator on directories.
 * @param path - the stored path.
 * @param directory - whether the entry stands for a directory.
 * @returns the display form.
 */
export function displayPath(path, directory) {
  return directory === true && !path.endsWith('/') ? `${path}/` : path
}

/** Why one typed path could not be normalized, in the command's own vocabulary. */
const PATH_ERRORS = {
  empty: '路径为空',
  'not-text': '不是文本路径',
  nul: '包含不可见字符',
  'too-long': '路径过长',
  'no-home': '无法确定主目录',
  'no-root': '无法确定工作区根目录',
  'unknown-user': '不支持 ~其他用户 的写法，请写完整路径',
}

const DIALOG_OPTIONS = [
  {
    label: '不允许',
    description: '拒绝这一次操作；模型会收到拒绝原因。',
    value: 'deny',
  },
  {
    label: '仅一次',
    description: '只允许这一次操作，下一次同类越界操作仍会询问。',
    value: 'once',
  },
  {
    // Filled in per family and per request: the dialog grants reads or writes,
    // never both, so the label has to say which one this choice covers.
    label: (kind) => (kind === 'write' ? '该对话中总是可以修改' : '该对话中总是可以访问'),
    description: (kind, dirs) => (dirs.length === 0
      ? '本次请求未能解析出具体路径，选它只对这一次生效；另一类（读取或修改）仍会单独询问。'
      : `把 ${dirs.map((dir) => displayPath(dir.path, dir.directory)).join('、')} 记入本对话的额外路径：这些目录下的全部文件与子目录一并允许${kind === 'write' ? '修改' : '访问'}，可在输入框右侧的“额外可读文件”控件里随时撤销；另一类（读取或修改）仍会单独询问。`),
    value: 'always',
  },
]

/**
 * Classify one dialog answer by its label or its value.
 * @param chosen - the answer text the question tool returned.
 * @param kind - the family the dialog asked about.
 * @returns `deny`, `once`, `always`, or undefined when nothing matches.
 */
export function answerOf(chosen, kind) {
  if (typeof chosen !== 'string' || chosen === '') return undefined
  for (const option of DIALOG_OPTIONS) {
    const label = typeof option.label === 'function' ? option.label(kind) : option.label
    if (chosen === label || chosen === option.value) return option.value
  }
  return undefined
}

/**
 * Build the question id one dialog uses. The id is the durable record of what
 * the user allowed, so it carries the family and the very entries at stake: a
 * conversation-scoped answer is pinned to those entries, never to a whole disk.
 * A directory is written with a trailing separator, so the record keeps saying
 * which entries stand for a subtree.
 * @param prefix - marker that identifies this plugin's own questions.
 * @param kind - the family being requested.
 * @param dirs - the entries the answer would cover (`{ path, directory }`).
 * @returns the question id.
 */
export function grantQuestionId(prefix, kind, dirs) {
  const encoded = dirs.map((dir) => (dir.directory === true ? `${dir.path}/` : dir.path))
  return `${prefix}${kind}|${encodeURIComponent(encoded.join('\u0001'))}`
}

/**
 * Decode one dialog question id back into the family and the entries it recorded.
 * @param questionId - the answered question's id.
 * @param prefix - marker that identifies this plugin's own questions.
 * @returns `{ kind, dirs }`, each entry `{ path, directory }`; undefined for a
 *   legacy or foreign id.
 */
export function parseGrantId(questionId, prefix) {
  if (typeof questionId !== 'string' || !questionId.startsWith(prefix)) return undefined
  const rest = questionId.slice(prefix.length)
  const separator = rest.indexOf('|')
  const kind = (separator === -1 ? rest : rest.slice(0, separator)).replace(/^.*\//, '')
  if (separator === -1) {
    // A legacy id named only the family: it answers the question but records no
    // path, so nothing is carried over from it.
    return kind === 'read' || kind === 'write' ? { kind, dirs: [] } : undefined
  }
  if (kind !== 'read' && kind !== 'write') return undefined
  let decoded = ''
  try {
    decoded = decodeURIComponent(rest.slice(separator + 1))
  } catch {
    return undefined
  }
  const dirs = decoded
    .split('\u0001')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const directory = entry.endsWith('/')
      return { path: directory && entry.length > 1 ? entry.slice(0, -1) : entry, directory }
    })
  return { kind, dirs }
}

/**
 * Fold the answered authorization dialogs out of the session log into the paths
 * they granted. Immutable groups answer questions, so the durable
 * `ask_user_question` call and its result are the record of a standing consent.
 * Only an “always” answer records paths: “once” and “deny” leave nothing behind.
 * @param session - the session whose events are folded.
 * @param dialogTool - wire name of the question tool this plugin asks through.
 * @param prefix - marker that identifies this plugin's own questions.
 * @returns granted `{ path, directory }` entries per family and the answered
 *   question ids.
 */
export function readGrants(session, dialogTool, prefix) {
  const granted = { read: [], write: [] }
  const answered = new Set()
  if (session === undefined || typeof session.snapshotEvents !== 'function') return { granted, answered }
  const calls = new Map()
  for (const event of session.snapshotEvents()) {
    const data = event?.data
    if (event?.type === 'tool/call' && data?.name === dialogTool) {
      const args = parseJson(data.arguments)
      const questions = Array.isArray(args?.questions) ? args.questions : []
      for (const question of questions) {
        if (typeof question?.id === 'string' && question.id.startsWith(prefix)) calls.set(data.callId, question.id)
      }
      continue
    }
    if (event?.type === 'tool/result' && calls.has(data?.message?.toolCallId)) {
      const questionId = calls.get(data.message.toolCallId)
      const answer = parseJson(data.message.content?.[0]?.text)
      const selected = Array.isArray(answer?.answers) ? answer.answers : []
      for (const item of selected) {
        if (item?.id !== questionId) continue
        const chosen = typeof item.custom === 'string' && item.custom !== ''
          ? item.custom
          : Array.isArray(item.selected) ? item.selected[0] : undefined
        answered.add(questionId)
        const record = parseGrantId(questionId, prefix)
        if (record === undefined || answerOf(chosen, record.kind) !== 'always') continue
        for (const dir of record.dirs) {
          const already = granted[record.kind].some((entry) => entry.path === dir.path && entry.directory === dir.directory)
          if (!already) granted[record.kind].push(dir)
        }
      }
    }
  }
  return { granted, answered }
}

/**
 * Parse one embedded JSON string without throwing.
 * @param value - candidate JSON text.
 * @returns the parsed value, or `undefined`.
 */
export function parseJson(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Host plugin body.
 * @param ctx - Host context.
 * @param config - validated row configuration.
 */
export function apply(ctx, config = {}) {
  const resolvedConfig = normalizeConfig(config)
  const levels = normalizeLevels(resolvedConfig.levels)
  const presetLevels = normalizePresetLevels(resolvedConfig.presetLevels, levels)
  const fallbackLevel = resolvedConfig.defaultLevel
  const treatReadOnlyAsNoAccess = resolvedConfig.treatReadOnlyAsNoAccess
  const opaquePolicy = resolvedConfig.opaquePolicy
  const dialogTool = 'ask_user_question'
  const questionPrefix = 'dsh-readwrite-gate/'
  /** Comment marker a dispatcher uses to declare one task's write slice. */
  const dispatchScopeMarker = 'dsh-access-scope:'

  /**
   * Conversation-scoped path grants, keyed `<sessionId>` then path. Each entry
   * records the families the user answered “always” for, on that exact path; the
   * session log is the durable record and this map is its cache.
   */
  const liveGrants = new Map()
  /** One serialized authorization queue per session, so dialogs never stack. */
  const askQueues = new Map()
  /** Per-conversation read allowlist, keyed by session id; in-process by design. */
  const readAllow = new Map()

  /**
   * Normalize the configured level table.
   * @param raw - configured `levels` object.
   * @returns level name to definition, with defaults filled in.
   */
  function normalizeLevels(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const out = new Map()
    for (const [name, definition] of Object.entries(source)) {
      if (!isLevel(definition?.level)) continue
      out.set(name, {
        name,
        preset: typeof definition.preset === 'string' ? definition.preset : undefined,
        level: definition.level,
        label: typeof definition.label === 'string' ? definition.label : name,
        description: typeof definition.description === 'string' ? definition.description : undefined,
        readScope: scopeOf(definition.readScope, 'workspace'),
        writeScope: scopeOf(definition.writeScope, 'workspace'),
      })
    }
    return out
  }

  /**
   * Build the preset-name to level-name map, letting the level table's own
   * `preset` fields win and the explicit `presetLevels` map fill the rest.
   * @param raw - configured `presetLevels` map.
   * @param table - normalized level table.
   * @returns preset name to level-table key.
   */
  function normalizePresetLevels(raw, table) {
    const out = new Map()
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    for (const [preset, level] of Object.entries(source)) {
      if (typeof preset === 'string' && (table.has(level) || isLevel(level))) out.set(preset, level)
    }
    // A level entry naming its own preset is authoritative: the operator wrote
    // the preset next to the level it belongs to, so it overwrites the map.
    for (const definition of table.values()) {
      if (definition.preset !== undefined) out.set(definition.preset, definition.name)
    }
    return out
  }

  /**
   * The level-TABLE KEY one name means.
   *
   * The key, not the level value, is what carries the entry: two presets may
   * share a level value (`workspace`) and still differ in read and write scope,
   * so resolving to the value alone would lose the definition.
   * @param name - level-table key or preset name.
   * @returns the table key, or `undefined`.
   */
  function levelKeyOf(name) {
    if (levels.has(name)) return name
    if (presetLevels.has(name)) return presetLevels.get(name)
    return undefined
  }

  /**
   * Read the session's current permission preset.
   * @param session - the session to read.
   * @returns the preset name, or `undefined` when it cannot be resolved.
   */
  function currentPreset(session) {
    try {
      const preset = ctx.permissionPresets.current(session)
      return typeof preset === 'string' ? preset : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the access level that applies to one session.
   *
   * Only explicit configuration grants a level: a preset named by the level
   * table or by `presetLevels`, then the read-only fallback when
   * `treatReadOnlyAsNoAccess` is on, then `defaultLevel`. The sandbox mode is
   * deliberately never read as a source of *permission*, because a mode the
   * operator did not map would otherwise silently widen this plugin's fence.
   * @param session - the session to resolve for.
   * @returns the level, its definition, and how it was resolved.
   */
  function resolveLevel(session) {
    // A delegated session has no permission preset of its own: the subagent
    // seam only forwards `auto` / `danger-full-access` to a child, so any other
    // parent preset leaves the child on the deployment default (`no-access`
    // here). Inheriting the nearest ancestor's resolved level keeps a dispatched
    // task at exactly the level its parent was granted, which is what the user
    // sees when they pick a level and then dispatch.
    const root = inheritanceRoot(session)
    if (root !== session) {
      const inherited = resolveLevel(root)
      return { ...inherited, source: `inherited-${inherited.source}`, inheritedFrom: root.id }
    }
    const preset = currentPreset(session)
    const fromPreset = preset === undefined ? undefined : levelKeyOf(preset)
    if (fromPreset !== undefined) {
      const definition = levels.get(fromPreset)
      return { level: definition?.level ?? fromPreset, key: fromPreset, definition, preset, source: 'preset-table' }
    }
    if (treatReadOnlyAsNoAccess && safeMode(session) === 'read-only') {
      return { level: 'none', key: 'none', definition: levels.get('none'), preset, source: 'read-only-mode' }
    }
    const definition = levels.get(fallbackLevel)
    // A fallback naming neither a configured level nor a known level value would
    // otherwise fall through the gate with no scope at all and let workspace
    // paths through. An unrecognized fallback therefore grants nothing.
    if (definition === undefined && !isLevel(fallbackLevel)) {
      return { level: 'none', key: 'none', definition: levels.get('none'), preset, source: 'default-level' }
    }
    return { level: definition?.level ?? fallbackLevel, key: fallbackLevel, definition, preset, source: 'default-level' }
  }

  /**
   * Walk up the delegation chain to the session whose own preset applies.
   *
   * `Session.header.parentSession` records the durable parent of a delegated
   * session; the live {@link Session} object is resolved through the `agents`
   * registry or, while the parent sits between turns, through the `sessions`
   * store. When neither resolves (an old persisted child, or a parent already
   * disposed) the session itself is returned and the ordinary default-level rule
   * applies.
   * @param session - the session to walk up from.
   * @returns the nearest non-delegated ancestor, or `session` itself.
   */
  function inheritanceRoot(session) {
    let current = session
    if (current?.header?.parentSession === undefined) return current
    for (let depth = 0; depth < 16; depth += 1) {
      const parentId = current?.header?.parentSession
      if (parentId === undefined) return current
      const parent = liveSession(parentId)
      if (parent === undefined || parent === session) return current
      current = parent
    }
    return current
  }

  /**
   * Look up a live session by its durable id.
   *
   * The `agents` registry keys running agents by session id; the session store
   * (`sessions`) keeps the same ids for sessions whose agent is between turns,
   * which is exactly the state a parent is in while its child runs. Trying both
   * keeps inheritance working in either case.
   * @param id - the durable session id.
   * @returns the session, or `undefined`.
   */
  function liveSession(id) {
    if (id === undefined) return undefined
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.get === 'function') {
      const agent = agents.get(id)
      if (agent?.session !== undefined) return agent.session
    }
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && typeof sessions.get === 'function') {
      return sessions.get(id)
    }
    return undefined
  }

  /**
   * Collect the human-readable text out of one event payload.
   *
   * The session log stores messages in the wire shape the model sees, so the
   * text may sit under `data.text`, `data.message.content`, or a content block
   * array. This walks the few keys that carry prose and ignores the rest.
   * @param value - one event payload, or a nested content value.
   * @param depth - recursion guard.
   * @returns the joined text, or `''` when the payload carries none.
   */
  function textOfEventValue(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map((item) => textOfEventValue(item, depth + 1)).join('\n')
    if (typeof value !== 'object') return ''
    return Object.values(value).map((item) => textOfEventValue(item, depth + 1)).join('\n')
  }

  /**
   * Read the write slice a dispatcher declared for a delegated session.
   *
   * A delegated session inherits its parent's level (see {@link resolveLevel}),
   * and that level is as wide as the whole conversation: the parent may edit
   * every path the user allowed, while one task of a split was only meant to
   * own a few of them. The dispatcher therefore declares the task's slice in the
   * first user message as an HTML comment
   * `<!-- dsh-access-scope: {"write":["src/a.js",".harness/runs/x/"]} -->`;
   * paths are workspace-relative and a trailing separator declares a directory,
   * exactly like the dialog answers. A delegated session without the marker
   * keeps the inherited level unchanged, so old dispatchers are not broken.
   * @param session - the delegated session to read.
   * @returns `{ dirs, covers }` when a scope was declared, else `undefined`.
   */
  function delegatedWriteScope(session) {
    if (session === undefined || session?.header?.origin !== 'subagent') return undefined
    const root = workspaceRoot(session)
    if (typeof root !== 'string' || root === '') return undefined
    let declared
    try {
      for (const event of typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) {
        // Only the dispatcher's own user message declares a slice. Tool traffic
        // carries output the model produced, and an assistant message is text the
        // constrained side wrote itself, so neither may widen the slice.
        if (event?.type !== 'user/message') continue
        const text = textOfEventValue(event?.data)
        const start = text.indexOf(dispatchScopeMarker)
        if (start < 0) continue
        const end = text.indexOf('-->', start)
        declared = parseJson(text.slice(start + dispatchScopeMarker.length, end < 0 ? text.length : end))
        if (declared !== undefined) break
      }
    } catch {
      return undefined
    }
    if (!Array.isArray(declared?.write)) return undefined
    const dirs = []
    for (const raw of declared.write) {
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const entry = normalizeUserPath(raw, { root, home: homedir() })
      if (entry.path !== '') dirs.push(entry.path)
    }
    if (dirs.length === 0) return undefined
    return {
      dirs,
      covers(path) {
        return dirs.some((dir) => containsPath(path, dir, root).contained)
      },
    }
  }

  /**
   * Read the effective sandbox mode without throwing.
   * @param session - the session to read.
   * @returns the mode, or `undefined`.
   */
  function safeMode(session) {
    try {
      return ctx.sandboxPolicy.resolve({ session }).mode
    } catch {
      return undefined
    }
  }

  /**
   * The absolute workspace root this session's paths are fenced against.
   * @param session - the session to read.
   * @returns the root path.
   */
  function workspaceRoot(session) {
    try {
      return ctx.sandboxPolicy.resolve({ session }).workspaceRoot
    } catch {
      return ctx.sandboxPolicy?.workspaceRoot
    }
  }

  /**
   * Look up a live session by agent identity.
   * @param agent - the calling agent.
   * @returns its session, or `undefined` when the agent is unknown.
   */
  function sessionOf(agent) {
    if (agent === undefined || agent === null) return undefined
    // The live Agent carries its session; the session is undefined only for a
    // caller that is not an Agent at all, which fails closed below.
    return agent.session
  }

  /**
   * The conversation-scoped path grants of one session, seeded once from its log.
   * @param session - the session to read.
   * @returns the path map, keyed by path.
   */
  function grantEntriesOf(session) {
    if (session === undefined) return new Map()
    const key = String(session.id)
    const cached = liveGrants.get(key)
    if (cached !== undefined) return cached
    const entries = new Map()
    try {
      // A delegated session also inherits the standing grants of its parent
      // conversation: the user authorized that directory for the run, and a
      // dispatched task is part of the same run. Own answers are folded after
      // the inherited ones so they can only add.
      const own = inheritanceRoot(session)
      const sources = own === session ? [session] : [own, session]
      for (const source of sources) {
        // A dispatched task runs inside the run that authorized the path, so the
        // parent's live grants are copied in. Its cache is authoritative: this
        // plugin asks through the question service, whose answer never becomes a
        // `tool/call` record, so a log replay cannot reproduce it.
        const inherited = liveGrants.get(String(source.id))
        if (inherited !== undefined) {
          for (const [path, entry] of inherited) {
            const target = entries.get(path) ?? { read: false, write: false }
            target.read = target.read === true || entry.read === true
            target.write = target.write === true || entry.write === true
            target.directory = target.directory === true || entry.directory === true
            entries.set(path, target)
          }
          continue
        }
        const replayed = readGrants(source, dialogTool, questionPrefix).granted
        // The log keeps whatever spelling the dialog asked about; the row is the
        // folded path, so a grant recorded from `a/../b` matches `b` here.
        for (const dir of replayed.read) {
          const path = canonicalPathOf(dir.path)
          const entry = entries.get(path) ?? { read: false, write: false }
          entry.read = true
          entry.directory = entry.directory === true || dir.directory === true
          entries.set(path, entry)
        }
        for (const dir of replayed.write) {
          const path = canonicalPathOf(dir.path)
          const entry = entries.get(path) ?? { read: false, write: false }
          entry.write = true
          entry.directory = entry.directory === true || dir.directory === true
          entries.set(path, entry)
        }
      }
    } catch {
      // An unreadable log grants nothing.
    }
    liveGrants.set(key, entries)
    return entries
  }

  /**
   * Record one conversation-scoped path grant. An answer covers a directory, so
   * every other file and subdirectory under it is covered without a new question.
   * @param session - the granting session.
   * @param kind - the granted family.
   * @param paths - the directories (or exact paths) the user allowed.
   * @param options - `directory: true` marks the entries as directories on screen.
   */
  function grantPaths(session, kind, paths, options = {}) {
    const entries = grantEntriesOf(session)
    for (const path of paths) {
      const entry = entries.get(path) ?? { read: false, write: false }
      entry[kind] = true
      entry.directory = entry.directory === true || options.directory === true
      entries.set(path, entry)
    }
  }

  /**
   * Name one row's families in the plugin's own vocabulary.
   * @param row - an extra-path row.
   * @returns the family text.
   */
  function familyText(row) {
    // A write grant implies the read it needs, so it is shown as covering both.
    return row.write === true ? '读+写' : '读'
  }

  /**
   * Join names into one line without letting the line grow without bound.
   * @param items - the names to join.
   * @param limit - how many names to spell out.
   * @returns the joined text.
   */
  function briefList(items, limit = 4) {
    if (items.length <= limit) return items.join('、')
    return `${items.slice(0, limit).join('、')} 等 ${items.length} 项`
  }

  /**
   * The identity of one extra path: the configured allowlist may store a
   * directory with a trailing separator while a dialog grant stores it without
   * one, and both names must stand for the same row.
   * @param path - an extra path.
   * @returns the path without trailing separators.
   */
  function canonicalPath(path) {
    return path.replace(/[\\/]+$/, '') || path
  }

  /**
   * Every path this conversation may use, with the families it covers: the
   * configured read allowlist plus the paths a dialog answer granted.
   * @param session - the session to read.
   * @returns rows in a stable order.
   */
  function extraRowsOf(session) {
    const rows = new Map()
    for (const path of readAllowOf(session)) {
      const key = canonicalPath(path)
      const row = rows.get(key) ?? { path, read: false, write: false, readable: false, directory: false }
      // A configured or typed entry says nothing about being a directory; a
      // trailing separator is the one signal the text carries.
      row.read = true
      row.directory = row.directory === true || /[\\/]$/.test(path)
      rows.set(key, row)
    }
    for (const [path, entry] of grantEntriesOf(session)) {
      const key = canonicalPath(path)
      const row = rows.get(key) ?? { path, read: false, write: false, readable: false, directory: false }
      row.read = row.read || entry.read === true
      row.write = row.write || entry.write === true
      row.directory = row.directory === true || entry.directory === true
      rows.set(key, row)
    }
    // Writing implies reading: nothing is modified without first being read, so
    // a write grant must satisfy the read side too, or the user would be asked
    // to authorize a read of the very path they just allowed modifying.
    for (const row of rows.values()) row.readable = row.read === true || row.write === true
    return [...rows.values()]
  }

  /**
   * The paths granted for one family.
   * @param session - the session to read.
   * @param kind - the family.
   * @returns the granted paths.
   */
  function grantedPathsOf(session, kind) {
    return extraRowsOf(session)
      .filter((row) => (kind === 'read' ? row.readable === true : row.write === true))
      .map((row) => row.path)
  }

  /**
   * Release the per-session dialog queue when an agent goes away.
   *
   * The grants stay: agents are re-attached for the same session, and the user's
   * answers — including removals that live only in memory — must survive that.
   * @param session - the session whose agent was disposed.
   */
  function forgetDialog(session) {
    if (session === undefined) return
    askQueues.delete(String(session.id))
  }

  /**
   * Release every per-session map once the conversation itself is gone.
   * @param session - the disposed session.
   */
  function forgetSession(session) {
    if (session === undefined) return
    const key = String(session.id)
    liveGrants.delete(key)
    askQueues.delete(key)
    readAllow.delete(key)

  }

  ctx.on('session/disposed', (session) => forgetSession(session))
  ctx.on('agent/disposed', (payload) => forgetDialog(payload?.agent?.session))

  /**
   * The entries of one list that cover every given path, all or nothing.
   * @param paths - the paths that must all be covered.
   * @param list - the covering entries.
   * @param root - the workspace root, when it resolves.
   * @param scopeBase - the base relative paths resolve against.
   * @returns the covering entries, or an empty array when one path is uncovered.
   */
  function coveringEntries(paths, list, root, scopeBase) {
    if (paths.length === 0 || list.length === 0) return []
    const matches = paths.map((path) => allowedBy(path, list, root, scopeBase))
    return matches.every((entry) => entry !== undefined) ? matches : []
  }

  /**
   * One operation family's situation: the paths it names, which of them leave
   * the workspace, and whether a standing decision already covers them.
   * @param session - the session in play, when there is one.
   * @param root - the workspace root, when it resolves.
   * @param scopeBase - the base relative paths resolve against.
   * @param kind - the family.
   * @param paths - every path this family touches.
   * @returns the family's verdict inputs.
   */
  function familyState(session, root, scopeBase, kind, paths) {
    const unique = [...new Set(paths)]
    const realRoot = root === undefined ? undefined : canonicalPathOf(root)
    // Every word is placed against the directory the call runs in before any
    // containment test: a relative word has no meaning on its own, and testing
    // it against the temp root first swallowed outside working directories.
    const outside = []
    const unresolved = new Set()
    for (const path of unique) {
      const absolute = absolutePathOf(path, scopeBase)
      if (absolute === undefined) {
        unresolved.add(path)
        outside.push(path)
        continue
      }
      // Canonical, folded paths: `..` must not survive into a stored grant, and
      // a symlink inside the workspace that points outside it must not read as
      // inside. The same folding runs on a typed removal, so both name one row.
      const folded = canonicalPathOf(absolute)
      // The temp area counts as inside: the platform sandbox writes there in the
      // same mode, so a dialog about it would only ask for what is already allowed.
      if (insideTempArea(folded)) continue
      if (realRoot !== undefined && containsPath(folded, realRoot, realRoot).contained) continue
      outside.push(folded)
    }
    // The read allowlist admits named outsiders without a dialog. It is
    // read-only by construction: a modification still goes through the gate.
    const admittedBy = session === undefined || kind !== 'read'
      ? []
      : coveringEntries(outside, readAllowOf(session), root, scopeBase)
    // A dialog answer records the paths it covered; they are matched the same
    // way, but they are an ordinary grant, so the level checks still come first.
    const grantedBy = session === undefined
      ? []
      : coveringEntries(outside, grantedPathsOf(session, kind), root, scopeBase)
    return { kind, paths: unique, outside, unresolved, admittedBy, grantedBy }
  }

  /**
   * The directory entries one authorization answer should cover. A command is
   * judged by the directory it works on, so an answer records directories: a
   * path already known to be a directory stays itself — the whole subtree is what
   * the user allowed — and anything else records the directory that holds it. One
   * grant then admits every other file and subdirectory below it.
   * @param kind - the family the dialog asks about.
   * @param paths - the paths that left the workspace.
   * @param operation - the classified operation, for its known directory targets.
   * @returns `{ path, directory: true }` entries, in request order.
   */
  function grantTargetsOf(kind, paths, operation) {
    const known = kind === 'write'
      ? (Array.isArray(operation?.writeDirTargets) ? operation.writeDirTargets : [])
      : (Array.isArray(operation?.targetDirs) ? operation.targetDirs : [])
    const seen = new Set()
    const dirs = []
    for (const path of paths) {
      const target = known.includes(path) ? path : directoryOf(path)
      if (seen.has(target)) continue
      seen.add(target)
      dirs.push({ path: target, directory: true })
    }
    return dirs
  }

  /**
   * Classify one tool call into its read and write halves.
   * @param agent - the calling agent.
   * @param name - wire tool name.
   * @param args - parsed tool arguments.
   * @returns the verdict, or `undefined` when the call touches no files.
   */
  function classify(agent, name, args) {
    const session = sessionOf(agent)
    const root = session === undefined ? undefined : workspaceRoot(session)
    // A search tool with no path reads the workspace root, so the classifier
    // needs the root it would search before it can say whether it touched files.
    const operation = classifyTool(name, args, { root })
    if (operation === undefined) return undefined
    const scopeBase = scopeBaseOf(args, root)
    const opaque = operation.opaque === true
    const readPaths = [
      ...(operation.readPaths ?? (operation.kind === 'read' ? operation.paths : [])),
      // An opaque command's text no longer names its own targets, so it is judged
      // by the directory it runs in: inside the workspace it is admitted, outside
      // it asks, instead of being refused outright.
      ...(opaque && Array.isArray(operation.targetDirs) ? operation.targetDirs : []),
    ]
    const writePaths = operation.writePaths ?? (operation.kind === 'write' ? operation.paths : [])
    return {
      operation,
      session,
      root,
      scopeBase,
      // The analyzer could not recover the command's own paths: an arbitrary
      // script or an unknown executable may touch anything, in either family.
      opaque,
      read: familyState(session, root, scopeBase, 'read', readPaths),
      write: familyState(session, root, scopeBase, 'write', writePaths),
    }
  }

  /**
   * The read allowlist of one session.
   * @param session - the session to read.
   * @returns its allowlist, always an array.
   */
  function readAllowOf(session) {
    if (session === undefined) return []
    const key = String(session.id)
    const cached = readAllow.get(key)
    if (cached !== undefined) return cached
    // The plugin's own configuration is the seed; edits made through
    // `/access-allow` live in this map and are lost when the plugin reloads.
    const configured = Array.isArray(config?.allow) ? config.allow : []
    const seeded = allowListOf({ allow: configured })
    readAllow.set(key, seeded)
    return seeded
  }

  /**
   * Replace one session's read allowlist.
   * @param session - the owning session.
   * @param allow - the new allowlist.
   */
  function setReadAllow(session, allow) {
    readAllow.set(String(session.id), allowListOf({ allow }))
  }

  /**
   * Ask the user to authorize one operation family.
   * @param session - the session whose conversation owns the consent.
   * @param agent - the calling agent, required for question ownership.
   * @param kind - the family being requested.
   * @param detail - what the call is trying to do, shown in the dialog.
   * @param directories - the directories the answer would cover.
   * @param signal - the tool call's cancellation signal.
   * @returns `allow-once`, `allow-always`, `deny`, or `unavailable`.
   */
  async function askAuthorization(session, agent, kind, detail, directories, signal) {
    const key = String(session.id)
    const previous = askQueues.get(key) ?? Promise.resolve()
    const queued = previous.then(
      () => runDialog(session, agent, kind, detail, directories, signal),
      () => runDialog(session, agent, kind, detail, directories, signal),
    )
    askQueues.set(key, queued.then(() => undefined, () => undefined))
    return queued
  }

  /**
   * Open one authorization dialog and interpret its answer.
   * @param session - the asking session.
   * @param agent - the calling agent.
   * @param kind - the family being requested.
   * @param detail - the operation description.
   * @param dirs - the directories the answer would cover.
   * @param signal - cancellation signal.
   * @returns the authorization outcome.
   */
  async function runDialog(session, agent, kind, detail, dirs, signal) {
    const questionId = grantQuestionId(questionPrefix, kind, dirs)
    const action = kind === 'write' ? '修改' : '访问'
    try {
      const answer = await ctx.userQuestions.ask({
        agent,
        signal,
        questions: [{
          id: questionId,
          header: kind === 'write' ? '请求修改授权' : '请求访问授权',
          question: `模型请求${action}工作区之外的文件，是否允许？`,
          detail,
          options: DIALOG_OPTIONS.map((option) => ({
            label: typeof option.label === 'function' ? option.label(kind) : option.label,
            description: typeof option.description === 'function' ? option.description(kind, dirs) : option.description,
          })),
        }],
      })
      const item = (answer?.answers ?? []).find((entry) => entry?.id === questionId)
      const chosen = typeof item?.custom === 'string' && item.custom !== ''
        ? item.custom
        : Array.isArray(item?.selected) ? item.selected[0] : undefined
      const chosenValue = answerOf(chosen, kind)
      if (chosenValue === undefined) return 'deny'
      if (chosenValue === 'always') {
        // "Always" remembers the entries the user was asked about; each covers
        // itself and everything under it.
        for (const dir of dirs) grantPaths(session, kind, [dir.path], { directory: dir.directory })
        return 'allow-always'
      }
      return chosenValue === 'once' ? 'allow-once' : 'deny'
    } catch {
      return 'unavailable'
    }
  }

  /**
   * Build the refusal text the model sees.
   * @param kind - the refused family.
   * @param detail - the operation description.
   * @param cause - why the operation was refused.
   * @returns one actionable sentence.
   */
  function refusal(kind, detail, cause) {
    const family = kind === 'write' ? '修改' : '访问'
    if (cause === 'level-none') {
      return `[access: 当前为“无权限”级别，访问和修改都被禁止] 已拒绝${family} ${detail}。请让用户在输入框的权限选择中切换级别后再试。`
    }
    if (cause === 'level-scope') {
      return `[access: 当前权限级别不授予“${family}”] 已拒绝${family} ${detail}。请让用户在输入框的权限选择中切换到更宽的级别后再试。`
    }
    if (cause === 'unavailable') {
      return `[access: 授权请求无法送达用户] 已拒绝${family} ${detail}；没有可用的交互界面，按失败即拒绝处理。`
    }
    if (cause === 'unknown-paths') {
      return `[access: 无法确定这个命令要访问的路径] 已拒绝${family} ${detail}。当前级别只允许工作区内的路径，而这个命令（脚本或未知程序）的路径无法从命令行读出；请改用路径明确的命令，或让用户在输入框切换级别后再试。`
    }
    return `[access: 用户未授权] 已拒绝${family} ${detail}。不要重试同一操作；先向用户说明为什么需要工作区之外的${family}。`
  }

  /**
   * Build the refusal text for a write that leaves the declared task slice.
   * @param detail - the operation description.
   * @param paths - the paths that left the slice.
   * @param dirs - the slice the dispatcher declared.
   * @returns one actionable sentence naming both sides.
   */
  /**
   * The directories an opaque command is judged against.
   *
   * A command's own `cd` decides where it runs, so `cd src && node build.mjs`
   * must be judged inside `src` rather than in the conversation's root. Without
   * a known directory the arguments' working directory is the only base.
   * @param classified - the classified tool call.
   * @param root - the workspace root.
   * @returns absolute directory paths, never empty.
   */
  function opaqueBases(classified, root) {
    const declared = Array.isArray(classified.operation?.targetDirs) ? classified.operation.targetDirs : []
    const bases = []
    for (const dir of declared) {
      if (typeof dir !== 'string' || dir === '') continue
      const resolved = normalizeUserPath(dir, { root, home: homedir() }).path
      if (resolved !== '' && !bases.includes(resolved)) bases.push(resolved)
    }
    return bases.length > 0 ? bases : [classified.scopeBase]
  }

  function refusalBeyondScope(detail, paths, dirs) {
    const allowed = dirs.map((dir) => displayPath(dir)).join('、')
    const offending = paths.map((path) => displayPath(path)).join('、')
    return `[access: 越界写入] 已拒绝修改 ${detail}：${offending} 不在这次派发声明的写入范围内（${allowed}）。请只修改任务声明过的路径；确实需要更多路径时，先向用户说明并由主 agent 重新拆分、重新派发。`
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const classified = classify(exec.agent, exec.name, exec.arguments)
    if (classified === undefined) return next()
    const { operation, session, opaque, read, write } = classified
    if (session === undefined) {
      return { kind: 'deny', reason: refusal(operation.kind, describe(exec.name, operation), 'unavailable') }
    }
    const resolved = resolveLevel(session)
    const definition = resolved.definition
    const level = definition?.level ?? resolved.level
    // A delegated session inherits the conversation's level; its dispatcher may
    // narrow just the write half to the task's own slice.
    const delegatedScope = delegatedWriteScope(session)
    if (level === 'full' && delegatedScope === undefined) return next()

    // Each family is judged against its own scope, so one command can read
    // inside, write outside, and be asked about exactly the outside half.
    // Modifications are decided first: they are the more sensitive half.
    for (const side of [write, read]) {
      const scope = side.kind === 'write' ? definition?.writeScope : definition?.readScope
      const detail = describe(exec.name, { ...operation, kind: side.kind }, side.outside)
      // An empty family has nothing to decide: a call that writes nothing is not
      // a modification, and a call that reads nothing is not a request. A known
      // modification whose targets stayed unreadable (`rm -rf $TARGET`) is still
      // a modification, and an opaque command may still touch this family.
      const present = side.paths.length > 0
        || opaque
        || (side.kind === 'write' && operation.kind === 'write')
      if (!present) continue
      // A named allowlist entry is an explicit, revision-proof user decision: it
      // admits its path even under the no-access level, because the entry
      // outranks the level the way an operator-set exception outranks a blanket
      // rule. It never admits a modification: the allowlist is read-only.
      if (side.kind === 'read' && side.admittedBy.length > 0) continue
      if (level === 'none') {
        return { kind: 'deny', reason: refusal(side.kind, detail, 'level-none') }
      }
      // A task's declaration outranks the inherited level for the write half:
      // the dispatcher already bounded this run, so writing beyond the slice is
      // refused without a dialog instead of asking the user to widen it.
      if (side.kind === 'write' && delegatedScope !== undefined) {
        const beyond = side.paths.filter((path) => !delegatedScope.covers(path))
        if (beyond.length > 0) {
          return { kind: 'deny', reason: refusalBeyondScope(detail, beyond, delegatedScope.dirs) }
        }
        // An opaque modification has no recovered targets; the directories it
        // runs in are the only thing that can be judged against the slice.
        if (opaque && side.paths.length === 0) {
          const beyond = opaqueBases(classified, classified.root).filter((base) => !delegatedScope.covers(base))
          if (beyond.length > 0) {
            return { kind: 'deny', reason: refusalBeyondScope(detail, beyond, delegatedScope.dirs) }
          }
        }
      }
      // A scope of `none` means the level grants no such operation at all. It is
      // refused before the standing grants are consulted, so a grant given under
      // a wider level cannot widen a narrower one back.
      if (scope === 'none') {
        // An opaque modification inside a level that forbids writing cannot land
        // anywhere: that level's own sandbox refuses every write, so running a
        // script is not the plugin's call to make from a command line it cannot
        // read. A modification whose targets were recovered is still refused.
        if (side.kind === 'write' && opaque && side.paths.length === 0) continue
        return { kind: 'deny', reason: refusal(side.kind, detail, 'level-scope') }
      }
      // A conversation-scoped grant admits the directories the user allowed and
      // everything under them, so a file elsewhere in an allowed directory needs
      // no new question.
      if (side.grantedBy.length > 0) continue
      if (side.outside.length > 0) {
        if (scope === 'anywhere') continue
        const dirs = grantTargetsOf(side.kind, side.outside, operation)
        const explanation = describeAuthorization(exec.name, classified, side)
        const outcome = await askAuthorization(session, exec.agent, side.kind, explanation, dirs, exec.signal)
        if (outcome === 'allow-once' || outcome === 'allow-always') {
          // The dialog is asynchronous, and the user may have narrowed the level
          // while it was open. A `deny` level reached afterwards refuses the call
          // it was asked about, so the answer never outlives the level it was
          // given under.
          const afterwards = resolveLevel(session)
          const afterDefinition = afterwards.definition
          const afterLevel = afterDefinition?.level ?? afterwards.level
          const afterScope = side.kind === 'write' ? afterDefinition?.writeScope : afterDefinition?.readScope
          if (afterLevel === 'none') {
            return { kind: 'deny', reason: refusal(side.kind, detail, 'level-none') }
          }
          if (afterScope === 'none') {
            return { kind: 'deny', reason: refusal(side.kind, detail, 'level-scope') }
          }
          continue
        }
        return {
          kind: 'deny',
          reason: refusal(side.kind, detail, outcome === 'unavailable' ? 'unavailable' : 'rejected'),
        }
      }
      // Every named path stays inside the workspace. What a command's own text
      // cannot prove is a question only for a family the sandbox does not
      // confine: writes stay inside by construction, reads do not. The default
      // policy judges an opaque command by the directory it runs in (it is part
      // of the read paths above), so nothing is left to refuse here; the strict
      // `opaquePolicy: deny` keeps the old refusal for deployments that want it.
      if (side.kind === 'read' && opaque && scope === 'workspace' && opaquePolicy === 'deny') {
        return { kind: 'deny', reason: refusal(side.kind, detail, 'unknown-paths') }
      }
    }
    return next()
  })

  /**
   * One session's read allowlist actions. Adding and removing are user-only:
   * this command has no tool face and is never reachable by the model.
   * @param session - the session whose allowlist changes.
   * @param rawInput - text after the command name.
   * @returns the command result.
   */
  function levelStatus(session) {
    const resolved = resolveLevel(session)
    const definition = resolved.definition
    const level = definition?.level ?? resolved.level
    const effective = (scope) => (level === 'none' ? 'none' : level === 'full' ? 'anywhere' : scope)
    const scopes = definition === undefined
      ? ''
      : `，读取 ${effective(definition.readScope)}，修改 ${effective(definition.writeScope)}`
    const live = livePresets()
    return [
      `当前级别：${definition?.label ?? resolved.level}（权限预设 ${resolved.preset ?? '未知'}，来源 ${resolved.source}${scopes}）${grantMarker(extraRowsOf(session))}`,
      live === undefined ? '运行中进程的预设表读取失败。' : `运行中进程的预设表：${live.join('、')}`,
      live !== undefined && !live.includes('no-access')
        ? '注意：运行中进程尚未载入本插件新增的权限类型，重启 Harness 后才能切换。'
        : undefined,
    ].filter((line) => line !== undefined).join('\n')
  }

  /**
   * Turn one typed path into the absolute path the plugin stores, and report
   * what it is when it already exists. Lexical normalization comes first, so
   * quotes, `~`, `$HOME`, `file://`, relative forms, and `.`/`..` all work; one
   * `stat` then decides directory versus file and resolves symlinks.
   * @param raw - the text the user typed.
   * @param root - the session workspace root, for relative paths.
   * @returns `{ path, directory, exists, error }`; `error` is set when the text
   *   cannot be understood, and `path` is then empty.
   */
  function typedPathOf(raw, root) {
    const normalized = normalizeUserPath(raw, {
      root,
      home: homedir(),
      windows: process.platform === 'win32',
      windowsMounts: windowsMounts(),
    })
    if (normalized.path === '') {
      const why = PATH_ERRORS[normalized.reason] ?? normalized.reason
      return { path: '', directory: false, exists: false, error: `无法识别路径“${raw}”：${why}。` }
    }
    let path = normalized.path
    let directory = normalized.directory
    let exists = false
    try {
      const info = statSync(path)
      exists = true
      directory = directory || info.isDirectory()
      // Resolve symlinks, so the stored path is the real one the gate compares.
      path = realpathSync(path)
    } catch {
      // A target may not exist yet: a write can name a file it will create, and
      // a user may pre-authorize a path that appears later. The lexical path stands.
    }
    return { path, directory, exists, error: '', mapped: normalized.mapped === true }
  }

  function allowCommand(session, rawInput) {
    const input = typeof rawInput === 'string' ? rawInput.trim() : ''
    const separator = input.indexOf(' ')
    const action = (separator === -1 ? input : input.slice(0, separator)).toLowerCase()
    const argument = separator === -1 ? '' : input.slice(separator + 1).trim()
    const configured = readAllowOf(session)
    const rows = extraRowsOf(session)

    if (action === '' || action === 'list') {
      return {
        kind: 'success',
        text: [
          `额外路径（本对话：可读 ${rows.filter((row) => row.readable === true).length} 项、可写 ${rows.filter((row) => row.write === true).length} 项）${allowMarker(rows)}`,
          rows.length === 0
            ? '（空；授权页选“该对话中总是可以访问/修改”会把该目录记到这里）'
            : rows.map((row, index) => `${index + 1}. ${displayPath(row.path, row.directory)}（${familyText(row)}）`).join('\n'),
          '添加可读：/access-allow add <文件或目录路径>',
          '添加可写：/access-allow add-write <文件或目录路径>（写包含读）',
          '移除：/access-allow remove <路径>（读和写一起移除）',
          '只移除写：/access-allow remove-write <路径>（remove-read 在可写行上会整行移除）',
          '路径可带引号，支持 ~、$HOME、file://、相对工作区的写法与 ..；目录可加结尾 /。',
          'Windows 盘符写法（如 C:\\Users\\me）会映射到它在 WSL 里的挂载路径（如 /mnt/c/Users/me）。',
          '目录条目覆盖其下全部文件与子目录。',
          levelStatus(session),
        ].join('\n'),
      }
    }
    if (action === 'add' || action === 'add-read' || action === 'add-write') {
      const family = action === 'add-write' ? 'write' : 'read'
      if (argument === '') return { kind: 'error', text: `用法：/access-allow ${action} <文件或目录路径>` }
      const root = workspaceRoot(session)
      const typed = typedPathOf(argument, root)
      if (typed.path === '') return { kind: 'error', text: typed.error }
      const target = typed.path
      const shown = displayPath(target, typed.directory)
      // A typed path that does not exist is still accepted — a write may name a
      // file it is about to create — but the answer says so, so a spelling
      // mistake does not look like a saved grant.
      const mappedNote = typed.mapped === true ? '；Windows 盘符路径已映射到该 WSL 路径' : ''
      const note = typed.exists
        ? `已识别为 ${shown}（${typed.directory ? '目录' : '文件'}${mappedNote}）。`
        : `已识别为 ${shown}${mappedNote}；注意：这个路径当前不存在，请确认没有拼写错误。`
      const covered = root !== undefined && containsPath(target, root, root).contained
      if (family === 'write') {
        // A write entry lives in the same place a dialog answer puts it, so
        // matching and the two-box removal behave identically.
        const existing = grantEntriesOf(session).get(target)
        if (existing !== undefined && existing.write === true) return { kind: 'success', text: `${note}已在列表中：${shown}（读+写）` }
        grantPaths(session, 'write', [target], { directory: typed.directory })
        return {
          kind: 'success',
          text: covered
            ? `${note}已添加 ${shown}（读+写）；该路径本就在工作区内。`
            : `${note}已添加 ${shown}（读+写）；本对话读取与修改该路径时都不再逐次询问。`,
        }
      }
      const implied = grantEntriesOf(session).get(target)
      if (implied !== undefined && implied.write === true) {
        return { kind: 'success', text: `${note}该路径的写权限已包含读，无需再单独添加读。` }
      }
      if (configured.includes(shown) || configured.includes(target)) {
        return { kind: 'success', text: `${note}已在列表中：${shown}（读）` }
      }
      setReadAllow(session, configured.concat([shown]))
      return {
        kind: 'success',
        text: covered
          ? `${note}已添加 ${shown}（读）；该路径本就在工作区内，无需额外授权。`
          : `${note}已添加 ${shown}（读）；本对话读取该路径时不再弹出授权页（修改仍需授权）。`,
      }
    }
    if (action === 'remove' || action === 'delete' || action === 'remove-read' || action === 'remove-write') {
      if (argument === '') return { kind: 'error', text: `用法：/access-allow ${action} <文件或目录路径>` }
      // The panel shows directory rows with a trailing separator; accept that
      // form as well as the stored one, and treat both spellings as one row.
      // The text is read the same way `add` reads it, so a quoted path, a home
      // prefix, or a Windows drive spelling names the row it was added as.
      const typed = typedPathOf(argument, workspaceRoot(session))
      const wanted = canonicalPath(typed.path === '' ? argument : typed.path)
      const row = rows.find((entry) => canonicalPath(entry.path) === wanted)
      if (row === undefined) return { kind: 'error', text: `列表中不存在：${argument}` }
      const target = row.path
      const key = canonicalPath(target)
      // `remove` revokes both families; `remove-read` / `remove-write` revoke one,
      // which is what the two boxes in the composer control mean by their ✕.
      // The read box's ✕ revokes the whole row: when the read is implied by a
      // write grant, removing only the read would leave the row readable.
      const impliedRead = action === 'remove-read' && row.write === true
      const dropRead = action !== 'remove-write'
      const dropWrite = action !== 'remove-read' || impliedRead
      // One row can be backed by the configured allowlist and the dialog grant
      // map under two spellings (with and without a trailing separator), so both
      // sides are matched by their canonical form.
      const grants = grantEntriesOf(session)
      let grantKey
      for (const name of grants.keys()) {
        if (canonicalPath(name) === key) {
          grantKey = name
          break
        }
      }
      if (dropRead) {
        setReadAllow(session, configured.filter((entry) => canonicalPath(entry) !== key))
      }
      if (grantKey !== undefined) {
        const entry = grants.get(grantKey)
        // The read side may already have deleted the row when nothing was left
        // of it, so the write side reads it again instead of relying on it.
        if (entry !== undefined) {
          if (dropRead) entry.read = false
          if (dropWrite) entry.write = false
          if (entry.read !== true && entry.write !== true) grants.delete(grantKey)
        }
      }
      const remaining = extraRowsOf(session).find((entry) => canonicalPath(entry.path) === key)
      return {
        kind: 'success',
        text: remaining === undefined
          ? `已移除 ${displayPath(target, row.directory)}（${familyText(row)}）。`
          : `已移除 ${displayPath(target, row.directory)} 的${dropRead ? '读' : ''}${dropRead && dropWrite ? '和' : ''}${dropWrite ? '写' : ''}权限；仍保留${familyText(remaining)}。`,
      }
    }
    if (action === 'clear') {
      setReadAllow(session, [])
      grantEntriesOf(session).clear()
      return { kind: 'success', text: '已清空本对话的额外路径。' }
    }
    return { kind: 'error', text: `未知操作“${action}”；可用：list、add、remove、clear。` }
  }

  ctx.commands.register({
    name: 'access-allow',
    description: '查看或维护本对话的额外路径列表（限制权限下可读或可写的工作区外文件或目录）',
    handler: (invocation) => {
      const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '无法解析当前会话。' }
      return allowCommand(session, invocation.rawInput)
    },
  })

  // The question service renders Markdown. Keep paths and command previews in
  // indented code blocks and visibly quote controls that could change the layout.
  function literalLine(value) {
    const safe = value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    return `    ${safe}`
  }

  function describeAuthorization(name, { operation, root, scopeBase, opaque }, side) {
    const paths = [...new Set(side.outside)]
    const shown = paths.slice(0, 8)
    const paragraphs = []
    if (paths.some((path) => !side.unresolved.has(path))) {
      paragraphs.push(root === undefined
        ? '**请求原因：** 无法确定工作区，不能确认已解析路径在允许范围内。'
        : '**请求原因：** 涉及工作区和临时目录以外的路径。')
    }
    if (side.unresolved.size > 0) {
      paragraphs.push('部分路径无法解析为绝对路径，不能确认它们在允许范围内。')
    }
    if (opaque) paragraphs.push('命令的实际目标未能完全识别；下列路径可能包含用于判定的目录，不代表完整的访问清单。')
    paragraphs.push('**触发授权的路径或目录**', shown.map((path) => literalLine(
      side.unresolved.has(path) ? `${path}（未解析）` : path,
    )).join('\n'))
    if (paths.length > shown.length) paragraphs.push(`另有 ${paths.length - shown.length} 项未展示。`)
    paragraphs.push('**工作区**', literalLine(root ?? '未知'),
      '**相对路径的起始基准**（命令内部可能改变目录）', literalLine(scopeBase ?? '未知'))
    if (operation.command) {
      const command = operation.command.length > 160 ? `${operation.command.slice(0, 157)}...` : operation.command
      paragraphs.push('**命令预览**', literalLine(command))
    }
    paragraphs.push('**调用工具**', literalLine(name), side.kind === 'write'
      ? '读取和修改分别授权。即使同意修改，操作仍须通过 DSH 沙箱检查。'
      : '允许读取不会授予修改权限。')
    return paragraphs.join('\n\n')
  }

  /**
   * Describe one classified call for the refusal message.
   * @param name - wire tool name.
   * @param operation - the classified operation.
   * @param outside - the paths that left the workspace.
   * @returns a short human-readable description.
   */
  function describe(name, operation, outside = []) {
    const family = operation.kind === 'write' ? '修改' : '访问'
    if (operation.command !== undefined && operation.command !== '') {
      const command = operation.command.length > 160 ? `${operation.command.slice(0, 157)}...` : operation.command
      return `工具 ${name} 的${family}操作 \`${command}\``
    }
    if (outside.length > 0) return `工具 ${name} 对 ${outside.join('、')} 的${family}操作`
    return `工具 ${name} 的${family}操作`
  }

  /**
   * Render the extra paths as one machine-readable marker the file-list control
   * parses out of `/access-allow` output. Each field is the percent-encoded path,
   * a bar, the families it covers, and `d` when the entry is a directory (the
   * row then stands for everything underneath it); fields are separated by a
   * unit separator so a path containing spaces or bars stays one field.
   * @param rows - the session's extra-path rows.
   * @returns the marker fragment appended to the status line.
   */
  function allowMarker(rows) {
    const encoded = rows
      .map((row) => {
        const families = `${row.readable === true ? 'r' : ''}${row.write === true ? 'w' : ''}`
        return `${encodeURIComponent(row.path)}|${families}${row.directory === true ? 'd' : ''}`
      })
      .join('\u0001')
    return ` [allow: ${encoded}]`
  }

  /**
   * Render the extra paths in prose for the status line and the model.
   * @param rows - the session's extra-path rows.
   * @returns the marker fragment appended to the status line.
   */
  function grantMarker(rows) {
    if (rows.length === 0) return ' [extra: none]'
    const text = rows.map((row) => `${familyText(row)} ${displayPath(row.path, row.directory)}`)
    return ` [extra: ${briefList(text)}]`
  }

  /**
   * The permission-preset names the mounted service actually offers. A preset
   * this plugin configures but the live table lacks cannot be switched to, so
   * the command reports both sides instead of failing opaquely.
   * @returns the live preset keys, or `undefined` when they cannot be read.
   */
  function livePresets() {
    try {
      const catalog = ctx.permissionPresets.catalog()
      const options = catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.options) ? catalog.options : []
      const names = options.map((option) => option.value).filter((value) => typeof value === 'string')
      return names.length === 0 ? undefined : names
    } catch {
      return undefined
    }
  }

  /**
   * Describe the current access level for the model.
   * @param session - the session the text belongs to.
   * @returns the section text, or `''` when no restriction applies.
   */
  function levelText(session) {
    const resolved = resolveLevel(session)
    const definition = resolved.definition
    const level = definition?.level ?? resolved.level
    if (level === 'full') return ''
    if (level === 'none') {
      return '当前访问权限：无权限。任何文件的读取与修改都会被拒绝，工作区内的文件也不例外；不要尝试读取或写入文件，应请用户在权限选择中切换级别。'
    }
    let rows = []
    try {
      rows = extraRowsOf(session)
    } catch {
      rows = []
    }
    const readScope = definition?.readScope ?? 'workspace'
    const writeScope = definition?.writeScope ?? 'workspace'
    const granted = rows.map((row) => `${displayPath(row.path, row.directory)}（${familyText(row)}）`)
    const root = workspaceRoot(session) ?? '未知'
    const readText = readScope === 'anywhere'
      ? '可读取任意路径的文件。'
      : readScope === 'none'
        ? '任何文件都不能读取。'
        : `只能查看工作区（${root}）和临时目录（${TEMP_AREA.join('、')}）内的文件；此外的区外路径需要用户授权，授权按目录记录：该目录下的全部文件与子目录随后都放行。`
    const writeText = writeScope === 'anywhere'
      ? '可修改任意路径的文件。'
      : writeScope === 'none'
        ? '任何修改都会被拒绝。'
        : `只能修改工作区（${root}）和临时目录（${TEMP_AREA.join('、')}）内的文件；此外的区外修改会先请求用户授权，但平台沙箱仍会拒绝工作区外的写入。`
    const asks = readScope === 'workspace' || writeScope === 'workspace'
    return [
      `当前访问权限：${definition?.label ?? resolved.key}。${readText}${writeText}`,
      asks ? (granted.length === 0 ? '本对话尚未授予任何额外路径。' : `本对话已授予的额外路径：${briefList(granted)}。`) : '',
      asks ? '读取与修改分开授权：越界操作会暂停并向用户弹出授权页，用户可选择“不允许”“仅一次”或“该对话中总是允许这个目录”（记入额外路径列表，可随时撤销）。' : '',
      asks ? '写权限包含读权限：授权修改一个目录后，读取该目录里的文件不再单独询问。' : '',
      asks ? `命令按真实路径判断：只要涉及的路径都在工作区或临时目录（${TEMP_AREA.join('、')}）内就不会弹授权页，管道、重定向、循环、变量赋值、就地修改和 heredoc 本身都不触发授权。` : '',
      readScope === 'workspace' ? '命令行里读不出路径的脚本或未知程序，按它所在的工作目录判断：工作目录在工作区内就放行，在工作区外会先询问用户。' : '',
    ].join('')
  }

  /**
   * Register the level statement on one agent's own context, so it appears only
   * for sessions the level actually restricts and disposes with that agent.
   * @param agent - the created agent.
   */
  function attachAgent(agent) {
    const session = agent?.session
    if (session === undefined) return
    agent.ctx.effect(() => {
      const dispose = agent.ctx.systemPrompt.section({
        name: 'access:permission-level',
        order: PROMPT_ORDER,
        interpolate: false,
        text: () => levelText(session),
      })
      return () => {
        dispose()
        forget(session)
      }
    }, 'readwrite-gate level section')
  }

  ctx.on('agent/created', (payload) => attachAgent(payload?.agent))
}
