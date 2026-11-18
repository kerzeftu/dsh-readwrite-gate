/**
 * Pure decision logic of the readwrite-gate plugin: tool-call classification,
 * workspace containment, and the resulting gate decision. No Host API is touched
 * here so the rules stay unit-testable.
 *
 * Shell lines are judged by the paths they really touch, never by their shape.
 * The tokenizer understands quotes, pipes, `&&`/`;` chains, redirects (including
 * the `2>` form), `for` loops, environment-variable prefixes, command
 * substitution and heredocs, so `grep … | head`, `cmd 2>/dev/null`, a loop over
 * workspace files or a heredoc with non-ASCII text are all ordinary input. The
 * verdict comes from the paths that come out of that walk, in two families:
 * `readPaths` and `writePaths`. A command that runs arbitrary code whose targets
 * cannot be read off its text (a script host, an unknown executable) is marked
 * `opaque`: it counts as a modification whose location is unknown, and the
 * caller decides what to do with a modification whose path it never saw.
 * @module dsh-readwrite-gate/functions
 */

/** Every access level a session can be in. */
export const LEVELS = ['full', 'workspace', 'none']

/** The authorized operation families; access and modification are granted separately. */
export const KINDS = ['read', 'write']

/* --------------------------------------------------------------- tables --- */

/** Executables whose plain invocation only reads, or only reports metadata. */
const READ_ONLY_EXECUTABLES = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'tac', 'od', 'xxd', 'strings',
  'ls', 'dir', 'vdir', 'tree', 'find', 'fd', 'stat', 'file', 'du', 'df', 'realpath',
  'readlink', 'basename', 'dirname', 'pwd', 'printenv', 'echo', 'printf', 'which',
  'where', 'type', 'command', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk',
  'gawk', 'cut', 'sort', 'uniq', 'tr', 'column', 'jq', 'yq', 'diff', 'cmp', 'comm',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'date', 'uname', 'whoami', 'id',
  'hostname', 'free', 'uptime', 'ps', 'netstat', 'ss', 'sed', 'git', 'node',
  'python', 'python3', 'ruby', 'perl', 'pnpm', 'npm', 'yarn', 'npx', 'tsx', 'jest',
  'vitest', 'eslint', 'tsc', 'cargo', 'go',
])

/**
 * Read-only executables whose positional operands are files even when they are
 * bare names (`cat secret`): a filename needs neither an extension nor a
 * separator. Every other read-only executable keeps the lexical test, because
 * its operands are patterns, formats or identifiers (`grep secret`, `printf %s`).
 */
const FILE_READ_OPERANDS = new Set([
  'cat', 'head', 'tail', 'tac', 'less', 'more', 'wc', 'nl', 'od', 'xxd',
  'strings', 'file', 'stat', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum',
  'cksum', 'base64', 'diff', 'cmp', 'comm', 'column', 'jq', 'yq', 'ls',
  'dir', 'vdir', 'du', 'realpath', 'readlink', 'tree', 'fd', 'iconv',
])

/** Options whose next word is a value, never an operand. */
const VALUE_OPTIONS = new Set([
  '-n', '-c', '-d', '-t', '-k', '-o', '-m', '--max-count', '--bytes',
  '--lines', '--delimiter', '--output', '--separator', '--pattern',
  '--exclude', '--include', '--color', '--format', '--width', '--tab-size',
  '--block-size', '--time-style', '--quoting-style',
])

/**
 * Whether the word after an option is that option's value rather than a file.
 *
 * Only a bare value counts: `head -n 5 file` consumes `5`, while `rm -f victim`
 * keeps `victim` because `-f` is a flag and `victim` is an operand.
 * @param option - the option word.
 * @param next - the word that follows it.
 * @returns `true` when `next` is the option's value.
 */
function optionTakesValue(option, next) {
  if (!VALUE_OPTIONS.has(option)) return false
  if (next === undefined) return false
  const value = String(next.value ?? '')
  if (value === '' || value.startsWith('-')) return false
  return !looksLikePath(value)
}

/**
 * Read-only tools whose omitted path means the session workspace itself. The
 * host's `glob` and `grep` search the workspace when no path is given, so an
 * empty argument list is a read of the root, not a call that touches nothing.
 */
const IMPLICIT_ROOT_TOOLS = new Set(['glob', 'grep', 'list_dir'])

/**
 * How to read the write targets out of one executable's arguments.
 *
 * `all`     — every path argument is a write target.
 * `dest`    — the last path argument is the target, the others are inputs.
 * `first`   — the first path argument is the target, the others are inputs.
 * `of`      — the target is the `of=` argument.
 * `output`  — the target is the argument of `-o`/`--output`.
 * `inplace` — the inputs are written only when an in-place flag is present.
 * `archive` — `-f` names the archive, `-C` the directory a program works in.
 */
const WRITE_RULES = new Map([
  ['rm', 'all'], ['rmdir', 'all'], ['unlink', 'all'], ['shred', 'all'],
  ['mkdir', 'all'], ['mknod', 'all'], ['mkfifo', 'all'], ['touch', 'all'],
  ['truncate', 'all'], ['fallocate', 'all'], ['chmod', 'all'], ['chown', 'all'],
  ['chgrp', 'all'], ['chattr', 'all'], ['setfacl', 'all'], ['setfattr', 'all'],
  ['mv', 'all'], ['tee', 'all'], ['patch', 'all'], ['dos2unix', 'all'],
  ['unix2dos', 'all'], ['sponge', 'all'],
  ['cp', 'dest'], ['rsync', 'dest'], ['install', 'dest'], ['ln', 'dest'],
  ['scp', 'dest'], ['convert', 'dest'],
  ['zip', 'first'], ['gzip', 'first'], ['gunzip', 'first'], ['bzip2', 'first'],
  ['xz', 'first'], ['unzip', 'first'], ['dd', 'of'], ['curl', 'output'],
  ['wget', 'output'], ['iconv', 'output'], ['sort', 'output'],
  ['sed', 'inplace'], ['perl', 'inplace'], ['awk', 'inplace'], ['gawk', 'inplace'],
  ['tar', 'archive'],
])

/** Flags that turn `sed`, `perl` and friends into in-place editors. */
const INPLACE_FLAGS = ['-i', '--in-place', '-pi', '-ni']

/** Shell builtins whose plain use touches no path. */
const SHELL_BUILTINS = new Set([
  'echo', 'printf', 'read', 'export', 'set', 'unset', 'local', 'declare', 'let',
  'shift', 'return', 'exit', 'true', 'false', ':', 'test', '[', '[[', 'cd',
  'source', '.', 'pushd', 'popd', 'dirs', 'umask', 'alias', 'unalias', 'hash',
  'times', 'ulimit', 'readonly', 'getopts', 'history', 'help', 'enable',
  'disown', 'suspend', 'jobs', 'wait', 'trap', 'kill', 'bg', 'fg', 'break',
  'continue', 'shift', 'caller', 'compgen', 'complete', 'bind',
])

/** Reserved words that introduce a compound command rather than run one. */
const RESERVED_WORDS = new Set([
  'for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done',
  'case', 'esac', 'select', 'function', 'in', '!', 'time', 'coproc',
])

/** Wrappers whose real operation is the command they were handed. */
const WRAPPER_EXECUTABLES = new Set([
  'env', 'time', 'nohup', 'nice', 'ionice', 'stdbuf', 'setsid', 'command',
  'exec', 'builtin', 'doas', 'sudo', 'xargs', 'chronic',
])

/** Shells whose `-c` argument is another command line to analyze. */
const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])

/** Executables that run whatever they are given, so a non-flag argument is code, not data. */
const SCRIPT_HOSTS = new Set([
  'node', 'nodejs', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun',
  'tsx', 'Rscript', 'lua', 'osascript', 'pwsh', 'powershell',
])

/** Flags whose argument is inline code rather than a file. */
const CODE_FLAGS = ['-e', '-c', '--eval', '-E', '-p', '-r', '--exec']

/** `git` subcommands that write to the work tree, the index, or the repository. */
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'config',
  'init', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert',
  'rm', 'stash', 'switch', 'tag', 'update-index', 'worktree',
])

/** Package-manager subcommands that fetch, link, publish, or otherwise write. */
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  'add', 'i', 'install', 'ci', 'publish', 'link', 'remove', 'rm', 'uninstall',
  'up', 'update', 'upgrade', 'dedupe', 'prune', 'create', 'init', 'exec', 'dlx',
])

/** Predicates whose own argument is a pattern or a value, never a search root. */
const FIND_PREDICATE_ARGS = new Map(Object.entries({
  '-name': 1, '-iname': 1, '-path': 1, '-ipath': 1, '-lname': 1, '-ilname': 1,
  '-regex': 1, '-iregex': 1, '-type': 1, '-maxdepth': 1, '-mindepth': 1,
  '-size': 1, '-perm': 1, '-user': 1, '-group': 1, '-newer': 1, '-anewer': 1,
  '-cnewer': 1, '-newermt': 1, '-printf': 1, '-fprintf': 2, '-links': 1,
  '-inum': 1, '-samefile': 1, '-amin': 1, '-atime': 1, '-mtime': 1, '-ctime': 1,
  '-regextype': 1, '-xtype': 1, '-uid': 1, '-gid': 1,
}))

/** Devices and pseudo-files that carry no workspace meaning, so they are never fenced. */
const NEUTRAL_PATHS = new Set([
  '/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty',
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/console', '/dev/full',
])

/** Prefixes of pseudo-files that are equally meaningless to fence. */
const NEUTRAL_PREFIXES = ['/dev/fd/', '/proc/self/fd/', '/dev/pts/', '/proc/self/fdinfo/']

/** Marker a command substitution leaves behind: its value cannot be known. */
const UNKNOWN_VALUE = '\u0000'

/** Argument keys whose string value is a filesystem path this plugin must fence. */
const PATH_KEYS = new Set([
  'file_path', 'path', 'paths', 'target', 'target_path', 'destination',
  'dir', 'directory', 'cwd', 'root', 'folder', 'file',
])

/** Argument keys that mean the call changes file content. */
const WRITE_KEYS = new Set(['content', 'new_string', 'old_string', 'new_text', 'newText', 'text', 'data'])

/** File-operation shape of one known tool call. */
const TOOL_SHAPES = {
  read: 'read',
  read_image: 'read',
  glob: 'read',
  grep: 'read',
  lsp: 'read',
  list_dir: 'read',
  stat: 'read',
  write: 'write',
  edit: 'write',
  str_replace_editor: 'write',
  apply_patch: 'write',
  create_file: 'write',
  move: 'write',
  delete: 'write',
  bash: 'shell',
  pwsh: 'shell',
  terminal_open: 'shell',
}

/* -------------------------------------------------------------- helpers --- */

/**
 * Whether one path names a device or pseudo-file that no level needs to fence.
 * @param path - a resolved or literal path.
 * @returns whether the path carries no workspace meaning.
 */
export function isNeutralPath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (NEUTRAL_PATHS.has(path)) return true
  return NEUTRAL_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/**
 * Whether one token names a filesystem location. Deliberately lexical, and
 * deliberately generous: a missed location is a missed prompt, while a spurious
 * one only costs a dialog. Plain identifiers (`install`, `main`) are not paths.
 * @param word - one token from the command line.
 * @returns whether the token should be checked against the workspace.
 */
/**
 * Whether one word is a URL rather than a filesystem path.
 *
 * Shell text carries `file:///…`, `https://…` and similar addresses; the bytes
 * after the scheme can look exactly like a path, so treating them as one denies
 * a harmless argument or, worse, invents a write target that never existed.
 * @param word - one shell word or inline-code literal.
 * @returns whether it starts with a URL scheme.
 */
export function isUrlLike(word) {
  // `file:///…` opens a local file, so it is a path rather than an address; every
  // other scheme (https, ftp, …) names no filesystem path and is ignored.
  return typeof word === 'string'
    && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)
    && fileUrlPath(word) === undefined
}

/**
 * The local path behind one `file://` address, when the word is one.
 *
 * `file:///etc/passwd` opens a local file; classifying it as a remote URL is
 * what let `curl file:///etc/passwd` pass as "touches no path".
 * @param word - one shell word or tool argument.
 * @returns the decoded absolute path, or `undefined` for every other scheme.
 */
/** The path forms a word can take, independent of the host it is read on. */
export function classifyPathForm(value) {
  if (typeof value !== 'string' || value === '') return 'relative'
  // `\\?\C:\x` and `\\.\Device` name a device namespace, not a file tree.
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(value)) return 'device'
  // `\\server\share` and `//server/share` are a share root, not a rooted path.
  if (/^[\\/]{2}[^\\/]/.test(value)) return 'unc'
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'drive'
  // `C:foo` is relative to that drive's current directory, which nothing here can know.
  if (/^[A-Za-z]:/.test(value)) return 'drive-relative'
  if (/^[\\/]/.test(value)) return 'root'
  return 'relative'
}

/**
 * The local path behind a `file:` URL.
 *
 * A file URL names a file on the *host* that serves the session, not in the
 * browser: `file:///C:/x` is a drive path, `file://server/share/x` is a share,
 * and `file:///x` is a rooted POSIX path. Percent escapes are decoded; the
 * result always uses `/` as its separator and keeps the form recognisable, so
 * one call site does not read `file:///C:/x` as `/C:/x` while another reads it
 * as `C:/x`.
 * @param word - the word to inspect.
 * @returns the path, or `undefined` when the word is not a file URL.
 */
export function fileUrlPath(word) {
  if (typeof word !== 'string') return undefined
  const match = /^file:\/\/([^\\/]*)([\s\S]*)$/i.exec(word)
  if (match === null) return undefined
  const host = match[1]
  let tail = match[2]
  try {
    tail = decodeURIComponent(tail)
  } catch {
    // A malformed escape keeps its literal text rather than dropping the path.
  }
  if (host !== '' && host.toLowerCase() !== 'localhost') {
    const rest = tail.replace(/^[\\/]+/, '')
    return rest === '' ? `//${host}` : `//${host}/${rest}`
  }
  if (tail === '' || /^[\\/]+$/.test(tail)) return '/'
  // `file:///C:/x` arrives with a leading slash the drive path does not have.
  const drive = /^[\\/]*([A-Za-z]:)([\\/][\s\S]*)?$/.exec(tail)
  if (drive !== null) return `${drive[1].toUpperCase()}${(drive[2] ?? '/').replace(/\\/g, '/')}`
  const rest = tail.replace(/\\/g, '/')
  return rest.startsWith('/') ? rest : `/${rest}`
}

/**
 * Fold `.` and `..` in a path without touching the filesystem.
 *
 * On Windows the fold keeps the anchor a path cannot climb out of: a drive
 * letter for `C:\x`, the two share segments for `\\server\share`. A `..`
 * that would leave the anchor stops there instead of turning into an escape.
 * On POSIX a backslash is an ordinary filename character, so it never splits.
 * @param value - the path to fold.
 * @param options - `windows` picks the separator rules; `base` resolves relative words.
 * @returns the folded path, or `undefined` for a form that cannot be placed.
 */
export function foldPath(value, options = {}) {
  if (typeof value !== 'string' || value === '') return undefined
  const windows = options.windows === true
  const form = classifyPathForm(value)
  if (form === 'device') return undefined
  if (windows) {
    if (form === 'drive-relative') return undefined
    const base = typeof options.base === 'string' && options.base !== '' ? options.base : ''
    let text = value
    if (form === 'relative') {
      const baseFolded = foldPath(base, { windows: true })
      if (baseFolded === undefined) return undefined
      text = `${baseFolded}\\${value}`
    } else if (form === 'root') {
      // A rooted path without a drive belongs to the drive the base sits on.
      const drive = /^([A-Za-z]):/.exec(base)
      const share = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(base)
      if (drive !== null) text = `${drive[1].toUpperCase()}:${value}`
      else if (share !== null) text = `\\\\${share[1]}\\${share[2]}${value}`
      else return undefined
    }
    const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)([\s\S]*)$/.exec(text)
    let anchor
    let body
    if (unc !== null) {
      anchor = `\\\\${unc[1]}\\${unc[2]}`
      body = unc[3]
    } else {
      const drive = /^([A-Za-z]):([\s\S]*)$/.exec(text)
      if (drive === null) return undefined
      anchor = `${drive[1].toUpperCase()}:`
      body = drive[2]
    }
    const out = []
    for (const part of body.split(/[\\/]+/)) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (out.length > 0) out.pop()
        continue
      }
      out.push(part)
    }
    return out.length === 0 ? `${anchor}\\` : `${anchor}\\${out.join('\\')}`
  }
  const base = typeof options.base === 'string' && options.base !== '' ? options.base : ''
  let text = value
  if (form === 'relative') {
    const baseFolded = foldPath(base)
    if (baseFolded === undefined) return undefined
    text = `${baseFolded}/${value}`
  }
  const rooted = /^[\\/]/.test(text)
  const out = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  const body = out.join('/')
  if (rooted) return body === '' ? '/' : `/${body}`
  return body
}

export function looksLikePath(word) {
  if (typeof word !== 'string' || word === '') return false
  if (word.startsWith('-')) return false
  if (word === '-' || word === '--') return false
  if (word.startsWith('~')) return true
  if (word === '.' || word === '..' || word === './' || word === '../') return true
  if (word.startsWith('/') || /^[A-Za-z]:[\\/]/.test(word)) return true
  if (/[\\/]/.test(word)) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(word)
}

/** The basename of one executable token. */
function baseName(word) {
  return String(word).replace(/^.*[/\\]/, '')
}

/** Whether one token is a `VAR=value` assignment. */
function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token.value ?? ''))
}

/* ------------------------------------------------------------ tokenizer --- */

/**
 * Split one command line into tokens the analyzer can walk: words (quotes and
 * escapes resolved, with flags saying whether the word was quoted or carried an
 * expansion) and operators. This is a real tokenizer, not a shape probe: pipes,
 * chains, redirects, loops, heredoc markers and command substitution are all
 * ordinary tokens here, and non-ASCII text is ordinary word content.
 * @param line - raw command line.
 * @returns `tokens`, plus whether the text ended inside an unterminated quote.
 */
export function tokenizeShell(line, { heredocs = false } = {}) {
  const text = typeof line === 'string' ? line : ''
  const tokens = []
  let current = ''
  let hasCurrent = false
  let quoted = false
  let quote = ''
  let index = 0
  const pushWord = () => {
    if (!hasCurrent) return
    tokens.push({ type: 'word', value: current, quoted })
    current = ''
    hasCurrent = false
    quoted = false
  }
  const markers = []
  let incompleteHeredoc = false
  const pushOp = (value) => {
    pushWord()
    if (heredocs && (value === '<<' || value === '<<-')) markers.push(tokens.length)
    tokens.push({ type: 'op', value })
  }
  const nextLine = (cursor) => {
    pushOp('\n')
    for (const marker of markers.splice(0)) {
      const op = tokens[marker]
      const delimiter = tokens[marker + 1]
      if (delimiter?.type !== 'word' || cursor >= text.length) {
        incompleteHeredoc = true
        break
      }
      const start = cursor
      while (cursor < text.length) {
        const newline = text.indexOf('\n', cursor)
        const end = newline < 0 ? text.length : newline
        const line = text.slice(cursor, end)
        const candidate = op.value === '<<-' ? line.replace(/^\t+/, '') : line
        if (candidate === delimiter.value) {
          const body = text.slice(start, cursor).replace(/\n$/, '')
          op.body = op.value === '<<-' ? body.replace(/^\t+/gm, '') : body
          op.bodyRange = [start, newline < 0 ? end : end + 1]
          cursor = op.bodyRange[1]
          break
        }
        cursor = newline < 0 ? end : end + 1
      }
      if (op.body === undefined) incompleteHeredoc = true
    }
    return cursor
  }
  while (index < text.length) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) { quote = ''; index += 1; continue }
      if (char === '\\' && quote === '"') { current += text[index + 1] ?? ''; index += 2; continue }
      current += char
      index += 1
      continue
    }
    if (char === "'" || char === '"') { quote = char; quoted = true; hasCurrent = true; index += 1; continue }
    if (char === '\\') { current += text[index + 1] ?? ''; hasCurrent = true; index += 2; continue }
    if (char === '#' && !hasCurrent) {
      const end = text.indexOf('\n', index)
      if (end === -1) break
      index = nextLine(end + 1)
      continue
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      const inner = end === -1 ? text.slice(index + 1) : text.slice(index + 1, end)
      tokens.push({ type: 'sub', value: inner })
      current += UNKNOWN_VALUE
      hasCurrent = true
      index = end === -1 ? text.length : end + 1
      continue
    }
    if (char === '$' && text[index + 1] === '(') {
      let depth = 1
      let cursor = index + 2
      let inner = ''
      while (cursor < text.length) {
        const inner_char = text[cursor]
        if (inner_char === '(') depth += 1
        else if (inner_char === ')') {
          depth -= 1
          if (depth === 0) break
        }
        inner += inner_char
        cursor += 1
      }
      tokens.push({ type: 'sub', value: inner })
      current += UNKNOWN_VALUE
      hasCurrent = true
      index = cursor + 1
      continue
    }
    const three = text.slice(index, index + 3)
    const two = text.slice(index, index + 2)
    if (three === '<<<' || three === '&>>' || three === '<<-') { pushOp(three); index += 3; continue }
    if (two === '&&' || two === '||' || two === '>>' || two === '<<' || two === '<>'
      || two === '&>' || two === '>&' || two === '<&' || two === '|&') {
      pushOp(two)
      index += 2
      continue
    }
    if (char === '\n') { index = nextLine(index + 1); continue }
    if ('|;&()'.includes(char)) { pushOp(char); index += 1; continue }
    if (char === '>' || char === '<') {
      if (/^\d+$/.test(current)) {
        const fd = current
        current = ''
        hasCurrent = false
        const longer = text[index + 1] === char ? char : ''
        pushOp(`${fd}${char}${longer}`)
        index += 1 + longer.length
        continue
      }
      pushOp(char)
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') { pushWord(); index += 1; continue }
    current += char
    hasCurrent = true
    index += 1
  }
  pushWord()
  return { tokens, unterminated: quote !== '' || incompleteHeredoc || markers.length > 0 }
}

/** Split shell source for diagnostics; the analyzer uses the attached tokens. */
export function splitHeredocs(line) {
  const text = typeof line === 'string' ? line : ''
  const { tokens } = tokenizeShell(text, { heredocs: true })
  const bodies = []
  let script = ''
  let end = 0
  let owner = ''
  for (const token of tokens) {
    if (token.bodyRange !== undefined) {
      const [start, stop] = token.bodyRange
      script += text.slice(end, start)
      end = stop
      bodies.push({ owner, text: token.body })
    } else if (token.type === 'op') {
      if (['\n', '&&', '||', ';', '|', '|&', '&', '(', ')'].includes(token.value)) owner = ''
    } else if (token.type === 'word' && owner === '' && !isAssignment(token)) {
      owner = baseName(token.value)
    }
  }
  return { script: script + text.slice(end), bodies }
}

/**
 * Classify one shell command line by the paths it touches.
 * @param line - the command line the model asked to run.
 * @returns `kind` (`read` or `write`), an explanatory `reason`, the `readPaths`
 * and `writePaths` it found, the combined `paths`, whether the line is
 * `opaque` (runs arbitrary code whose targets cannot be read off its text), the
 * `targetDirs` an opaque command is judged against, and the `writeDirTargets`
 * among its write paths (the ones that are directories themselves).
 */
export function analyzeShell(line) {
  const text = typeof line === 'string' ? line : ''
  const state = {
    cwd: undefined,
    cwdKnown: true,
    vars: new Map(),
    read: [],
    write: [],
    opaque: false,
    mayWrite: false,
    reasons: new Set(),
    depth: 0,
    scopes: [],
    // Directories an opaque command must be judged against: its own working
    // directory, because that is the one place its text ties it to.
    targetDirs: new Set(),
    // Write paths that are directories themselves, so a grant can keep them whole.
    directoryWrites: new Set(),
  }
  walkScript(text, state)
  const writePaths = dedupe(state.write)
  const readPaths = dedupe(state.read).filter((path) => !writePaths.includes(path))
  const opaque = state.opaque
  const kind = writePaths.length > 0 || opaque || state.mayWrite ? 'write' : 'read'
  const reason = state.reasons.size > 0 ? [...state.reasons].join('+') : 'paths'
  return {
    kind,
    reason,
    readPaths,
    writePaths,
    paths: [...writePaths, ...readPaths],
    opaque,
    mayWrite: state.mayWrite,
    targetDirs: [...state.targetDirs],
    writeDirTargets: writePaths.filter((path) => state.directoryWrites.has(path)),
  }
}

/** Drop duplicates while keeping the first occurrence's order. */
function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Walk one command line, splitting it into simple commands at operators and
 * recursing into command substitution.
 * @param text - the line (or inline script) to walk.
 * @param state - the running analysis state.
 */
export function walkScript(text, state) {
  if (state.depth > 6) {
    state.opaque = true
    state.targetDirs.add(literalCwd(state))
    return
  }
  const { tokens, unterminated } = tokenizeShell(text, { heredocs: true })
  if (unterminated) {
    state.reasons.add('unterminated-source')
    state.opaque = true
    state.targetDirs.add(literalCwd(state))
  }
  let pending = []
  let bodies = []
  const runPending = () => {
    if (pending.length !== 0) runCommand(pending, state, bodies)
    pending = []
    bodies = []
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'sub') {
      state.depth += 1
      walkScript(token.value, state)
      state.depth -= 1
      continue
    }
    if (token.type === 'op') {
      const value = token.value
      if (value === '<<' || value === '<<-') {
        if (token.body !== undefined) bodies.push(token.body)
        if (tokens[index + 1]?.type === 'word') index += 1
        continue
      }
      if (value === '<' || value === '<<<' || /^\d+<$/.test(value)) {
        const target = tokens[index + 1]
        if (target !== undefined && target.type === 'word') {
          recordWord(target, 'read', state)
          index += 1
        }
        continue
      }
      // File-descriptor duplication (`2>&1`, `>&2`, `2>&-`): the operand is a
      // descriptor, never a path. Consume it and record nothing — otherwise
      // `cmd 2>&1` reads as a redirect to the path `1` or an unknown executable.
      if (value === '>&' || /^\d+>&$/.test(value)) {
        index += 1
        continue
      }
      if (value === '>' || value === '>>' || value === '<>' || value === '&>' || value === '&>>' || /^\d+>$/.test(value) || /^\d+>>$/.test(value)) {
        const target = tokens[index + 1]
        if (target !== undefined && target.type === 'word') {
          recordWord(target, 'write', state)
          index += 1
        } else {
          state.reasons.add('redirect-without-target')
          state.opaque = true
        }
        continue
      }
      if (value === '(') {
        runPending()
        state.scopes.push({ cwd: state.cwd, cwdKnown: state.cwdKnown, vars: new Map(state.vars) })
        continue
      }
      if (value === ')') {
        runPending()
        const saved = state.scopes.pop()
        if (saved !== undefined) {
          state.cwd = saved.cwd
          state.cwdKnown = saved.cwdKnown
          state.vars = saved.vars
        }
        continue
      }
      runPending()
      continue
    }
    pending.push(token)
  }
  runPending()
}

/**
 * Analyze one simple command: strip assignments and wrappers, then decide which
 * of its arguments are read and which are written.
 * @param tokens - the command's tokens.
 * @param state - the running analysis state.
 */
function runCommand(tokens, state, bodies = []) {
  let index = 0
  const assignments = []
  while (index < tokens.length && (isAssignment(tokens[index]) || RESERVED_WORDS.has(tokens[index].value))) {
    assignments.push(tokens[index])
    index += 1
    if (index >= tokens.length) break
    // `for NAME in a b c` binds a loop variable to every listed word.
    if (assignments[assignments.length - 1].value === 'for' && tokens[index] !== undefined
      && tokens[index + 1] !== undefined && tokens[index + 1].value === 'in') {
      const name = tokens[index].value
      const values = []
      let cursor = index + 2
      while (cursor < tokens.length && !RESERVED_WORDS.has(tokens[cursor].value)) {
        const expanded = expandWord(tokens[cursor], state)
        values.push(...expanded)
        cursor += 1
      }
      if (values.length > 0) state.vars.set(name, values)
      index = cursor
    }
  }
  // A leading `VAR=value` binds for the rest of the line, so `X=/etc/passwd;
  // cat "$X"` names the same file the assignment wrote down — including the
  // line that only assigns, which ends here without running a command.
  for (const token of assignments) if (isAssignment(token)) rememberAssignment(token, state)
  if (index >= tokens.length) return
  let executable = baseName(tokens[index].value)
  let guard = 0
  while (WRAPPER_EXECUTABLES.has(executable) && guard < 8) {
    guard += 1
    index += 1
    while (index < tokens.length) {
      const token = tokens[index]
      if (isAssignment(token)) { rememberAssignment(token, state); index += 1; continue }
      if (token.value.startsWith('-') && token.value !== '-') {
        // `env -i`, `nice -n 5`, `stdbuf -o 0`: skip the flag and its value.
        const takesValue = ['-n', '-o', '-e', '-u', '-C', '-S', '--unset', '--chdir'].includes(token.value)
        index += takesValue ? 2 : 1
        continue
      }
      break
    }
    if (index >= tokens.length) return
    executable = baseName(tokens[index].value)
  }
  const args = tokens.slice(index + 1)
  const exe = executable

  if (exe === 'cd') {
    const target = args[0] === undefined ? undefined : expandWord(args[0], state)
    if (target === undefined || target.length === 0) state.cwdKnown = false
    else state.cwd = resolveText(target[0], state.cwd)
    return
  }
  if (exe === 'eval') {
    const inner = args.map((token) => token.value).join(' ')
    state.depth += 1
    walkScript(inner, state)
    state.depth -= 1
    return
  }
  if (exe === 'source' || exe === '.') {
    for (const token of args) recordWord(token, 'read', state)
    state.opaque = true
    state.reasons.add('sourced-script')
    state.targetDirs.add(literalCwd(state))
    return
  }
  if (SHELL_EXECUTABLES.has(exe)) {
    const code = flagValue(args, ['-c'])
    if (code !== undefined) {
      state.depth += 1
      walkScript(code, state)
      state.depth -= 1
      return
    }
    if (bodies.length > 0) {
      const saved = { cwd: state.cwd, cwdKnown: state.cwdKnown, vars: state.vars, scopes: state.scopes }
      state.vars = new Map(state.vars)
      state.scopes = []
      state.depth += 1
      for (const body of bodies) walkScript(body, state)
      state.depth -= 1
      Object.assign(state, saved)
    }
    for (const token of args) recordWord(token, 'read', state)
    state.opaque = true
    state.reasons.add('shell-script')
    state.targetDirs.add(literalCwd(state))
    return
  }
  if (SCRIPT_HOSTS.has(exe)) {
    const code = flagValue(args, CODE_FLAGS)
    for (const token of args) {
      if (token.value.startsWith('-')) continue
      if (code !== undefined && token.value === code) continue
      recordWord(token, 'read', state)
    }
    if (code !== undefined) analyzeCode(code, state)
    for (const body of bodies) analyzeCode(body, state)
    if (code === undefined) {
      state.opaque = true
      state.reasons.add('arbitrary-script')
      state.targetDirs.add(literalCwd(state))
    }
    return
  }
  if (exe === 'git') {
    const subcommand = positionalAfterOptions(args, ['-C', '--git-dir', '--work-tree', '-c', '--namespace', '--exec-path'])
    const repo = optionValue(args, ['-C', '--git-dir', '--work-tree'])
    if (subcommand === '' || GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
      state.mayWrite = true
      state.write.push(repo !== undefined ? repo : literalCwd(state))
    } else {
      for (const token of args) recordWord(token, 'read', state)
    }
    return
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'pip', 'pip3'].includes(exe)) {
    const subcommand = positionalAfterOptions(args, ['--prefix', '-C', '--dir', '--registry', '--tag', '--filter'])
    if (subcommand === '' || PACKAGE_WRITE_SUBCOMMANDS.has(subcommand) || exe === 'npx') {
      const prefix = optionValue(args, ['--prefix', '-C', '--dir'])
      state.mayWrite = true
      state.write.push(prefix !== undefined ? prefix : literalCwd(state))
    }
    return
  }
  if (exe === 'find') {
    analyzeFind(args, state)
    return
  }
  const rule = WRITE_RULES.get(exe)
  if (rule !== undefined) {
    applyWriteRule(exe, rule, args, state)
    return
  }
  if (READ_ONLY_EXECUTABLES.has(exe) || SHELL_BUILTINS.has(exe)) {
    // `export X=…`, `local X=…` and friends bind a variable for the rest of the
    // line even though the builtin itself reads nothing.
    if (['export', 'local', 'declare', 'readonly', 'typeset', 'set'].includes(exe)) {
      for (const token of args) if (isAssignment(token)) rememberAssignment(token, state)
    }
    const operands = FILE_READ_OPERANDS.has(exe)
    for (let cursor = 0; cursor < args.length; cursor += 1) {
      const token = args[cursor]
      if (operands && optionTakesValue(token.value, args[cursor + 1])) { cursor += 1; continue }
      recordWord(token, 'read', state, { bare: operands })
    }
    return
  }
  // An unknown executable's intent cannot be read off its name: it may write
  // anywhere, so the line is opaque, while the paths it names are still reads.
  // Its working directory is the one place its text ties it to.
  for (const token of args) recordWord(token, 'read', state)
  state.opaque = true
  state.reasons.add('unknown-executable')
  state.targetDirs.add(literalCwd(state))
}

/** The first non-flag argument. */
function firstPositional(args) {
  for (const token of args) {
    if (!token.value.startsWith('-')) return baseName(token.value)
  }
  return ''
}

/** The value of the first flag in `flags` that carries one. */
function flagValue(args, flags) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value
    if (flags.includes(value)) return args[index + 1] === undefined ? '' : args[index + 1].value
    const inline = flags.find((flag) => value.startsWith(`${flag}=`))
    if (inline !== undefined) return value.slice(inline.length + 1)
  }
  return undefined
}

/** The value of the first option in `options`, in `--opt=value` or `--opt value` form. */
function optionValue(args, options) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value
    for (const option of options) {
      if (value === option) return args[index + 1] === undefined ? undefined : args[index + 1].value
      if (value.startsWith(`${option}=`)) return value.slice(option.length + 1)
    }
  }
  return undefined
}

/**
 * The value of a short option that may be bundled with other letters, so
 * `tar -cf out.tar …` and `tar -f out.tar …` both name `out.tar`.
 * @param args - the command's tokens.
 * @param letters - the letters that take a value.
 * @returns the value, or `undefined` when the option is absent.
 */
function shortOptionValue(args, letters) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value
    if (!value.startsWith('-') || value.startsWith('--') || value === '-') continue
    for (const letter of letters) {
      const at = value.indexOf(letter, 1)
      if (at === -1) continue
      const inline = value.slice(at + 1)
      if (inline !== '') return inline
      return args[index + 1] === undefined ? undefined : args[index + 1].value
    }
  }
  return undefined
}

/** The first positional argument, skipping the values of the named options. */
function positionalAfterOptions(args, valueOptions) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value
    if (valueOptions.includes(value)) { index += 1; continue }
    if (value.startsWith('-')) continue
    if (isAssignment(args[index])) continue
    return baseName(value)
  }
  return ''
}

/** Apply one executable's write rule to its arguments. */
function applyWriteRule(exe, rule, args, state) {
  // Operands in argument order: a rule that names one target has to know which
  // argument comes last, and `cp /etc/passwd out` reads one file and writes
  // another only once the copy's source is not mistaken for its destination.
  const ordered = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (isAssignment(token)) continue
    if (token.value.startsWith('-')) {
      if (optionTakesValue(token.value, args[index + 1])) index += 1
      continue
    }
    ordered.push(token)
  }
  const paths = [...ordered]
  if (rule === 'all') {
    state.mayWrite = true
    // These remove or create directories themselves, so their operands are
    // directory targets: an authorization for one keeps the whole subtree.
    const recursive = args.some((token) => token.value === '--recursive' || /^-[A-Za-z]*[rR]/.test(token.value))
    const directory = exe === 'mkdir' || exe === 'rmdir' || (exe === 'rm' && recursive)
    for (const token of paths) recordWord(token, 'write', state, { directory, bare: true })
    return
  }
  if (rule === 'dest') {
    state.mayWrite = true
    const target = paths.pop()
    for (const token of paths) recordWord(token, 'read', state, { bare: true })
    if (target !== undefined) recordWord(target, 'write', state, { bare: true })
    else {
      state.reasons.add('missing-destination')
      state.opaque = true
    }
    return
  }
  if (rule === 'first') {
    state.mayWrite = true
    const target = paths.shift()
    if (target !== undefined) recordWord(target, 'write', state, { bare: true })
    for (const token of paths) recordWord(token, 'read', state, { bare: true })
    return
  }
  if (rule === 'of') {
    state.mayWrite = true
    const output = args.find((token) => token.value.startsWith('of='))
    if (output !== undefined) {
      recordWord({ type: 'word', value: output.value.slice(3), quoted: false }, 'write', state, { bare: true })
    }
    // `dd if=/etc/passwd` reads that file; dropping the input half is what made
    // an outside read look like a write with no source.
    const input = args.find((token) => token.value.startsWith('if='))
    if (input !== undefined) {
      recordWord({ type: 'word', value: input.value.slice(3), quoted: false }, 'read', state, { bare: true })
    }
    for (const token of args) {
      if (token.value.startsWith('if=') || token.value.startsWith('of=')) continue
      if (token.value.startsWith('-')) continue
      recordWord(token, 'read', state, { bare: true })
    }
    return
  }
  if (rule === 'output') {
    const value = optionValue(args, ['-o', '--output', '-O']) ?? shortOptionValue(args, ['o', 'O'])
    if (value !== undefined) {
      state.mayWrite = true
      recordWord({ type: 'word', value, quoted: false }, 'write', state)
    }
    for (const token of paths) {
      if (value !== undefined && token.value === value) continue
      recordWord(token, 'read', state, { bare: true })
    }
    return
  }
  if (rule === 'inplace') {
    const inplace = args.some((token) => token.value.startsWith('-i') || INPLACE_FLAGS.includes(token.value))
    if (inplace) state.mayWrite = true
    // Without `-e`/`-f` the first positional argument is the program text, not a path.
    const scripted = args.some((token) => ['-e', '-f', '--expression', '--file', '--regexp']
      .some((flag) => token.value === flag || token.value.startsWith(`${flag}=`)))
    const positionals = args.filter((token) => !token.value.startsWith('-') && !isAssignment(token))
    const operands = scripted ? positionals : positionals.slice(1)
    for (const token of operands) recordWord(token, inplace ? 'write' : 'read', state)
    return
  }
  if (rule === 'archive') {
    const archive = optionValue(args, ['-f', '--file']) ?? shortOptionValue(args, ['f'])
    const chdir = optionValue(args, ['-C', '--directory']) ?? shortOptionValue(args, ['C'])
    const extracting = args.some((token) => /^-[A-Za-z]*x/.test(token.value))
    const creating = args.some((token) => /^-[A-Za-z]*[cru]/.test(token.value))
    if (creating || extracting) state.mayWrite = true
    if (archive !== undefined && archive !== '-') {
      recordWord({ type: 'word', value: archive, quoted: false }, creating || !extracting ? 'write' : 'read', state)
    }
    if (chdir !== undefined) {
      if (extracting) recordWord({ type: 'word', value: chdir, quoted: false }, 'write', state)
      else recordWord({ type: 'word', value: chdir, quoted: false }, 'read', state)
    }
    if (extracting && chdir === undefined) state.write.push(literalCwd(state))
    for (const token of args) {
      if (token.value.startsWith('-')) continue
      if (token.value === archive || token.value === chdir) continue
      recordWord(token, 'read', state)
    }
    return
  }
  for (const token of paths) recordWord(token, rule === 'read' ? 'read' : 'write', state)
}

/** Analyze one `find` invocation: predicates can write even though `find` reads. */
function analyzeFind(args, state) {
  // Search roots come first; everything from the first `-predicate` on is a test.
  const roots = []
  let index = 0
  while (index < args.length && !args[index].value.startsWith('-')) {
    roots.push(args[index])
    index += 1
  }
  let deleting = false
  for (; index < args.length; index += 1) {
    const value = args[index].value
    if (value === '-delete') { deleting = true; continue }
    if (value === '-fprint' || value === '-fprint0' || value === '-fls') {
      const target = args[index + 1]
      if (target !== undefined) {
        state.mayWrite = true
        recordWord(target, 'write', state)
        index += 1
      }
      continue
    }
    if (value === '-exec' || value === '-execdir' || value === '-ok' || value === '-okdir') {
      const inner = []
      let cursor = index + 1
      while (cursor < args.length && args[cursor].value !== ';' && args[cursor].value !== '+') {
        inner.push(args[cursor])
        cursor += 1
      }
      if (inner.length > 0) runCommand(inner, state)
      state.opaque = true
      state.targetDirs.add(literalCwd(state))
      index = cursor
      continue
    }
    const arity = FIND_PREDICATE_ARGS.get(value)
    if (arity !== undefined) index += arity
  }
  // `-delete` turns the search roots into write targets; a root is a directory,
  // so a grant for it should keep the whole subtree.
  if (deleting) state.mayWrite = true
  for (const token of roots) recordWord(token, deleting ? 'write' : 'read', state, { directory: deleting })
}

/** Analyze inline code: its string literals are the paths it names. */
function analyzeCode(code, state) {
  const text = String(code ?? '')
  state.opaque = true
  // Inline code runs in the command's working directory, which is therefore the
  // directory it is judged against.
  state.targetDirs.add(literalCwd(state))
  const literal = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`/g
  let match = literal.exec(text)
  while (match !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const value = raw.replace(/\\n|\\t|\\r/g, ' ')
    if (value !== '' && looksLikePath(value) && !isUrlLike(value)) {
      const window = text.slice(Math.max(0, match.index - 60), match.index + value.length + 60)
      const writes = /(writeFileSync|writeFile|appendFile|createWriteStream|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|copyFile|unlinkSync|unlink|truncateSync|truncate|chmodSync|chmod|write_text|write_bytes|openSync|os\.remove|os\.rename|os\.makedirs|os\.mkdir|shutil\.|Path\([^)]*\)\.(write|unlink|mkdir|touch)|to_csv|to_json|savefig|(?<![=!<>-])>{1,2}\s*[^=\s>])/.test(window)
      const mode = /['"](w|a|x|w\+|a\+|r\+)['"]/.test(window)
      state[writes || mode ? 'write' : 'read'].push(
        fileUrlPath(value) ?? resolveText(value, state.cwdKnown ? state.cwd : undefined),
      )
    }
    match = literal.exec(text)
  }
}

/** Remember one `VAR=value` assignment so later `$VAR` references resolve. */
function rememberAssignment(token, state) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(String(token.value ?? ''))
  if (match === null) return
  state.vars.set(match[1], match[2] === '' ? [''] : [match[2]])
}

/** Record one word's expanded paths in one family. */
function recordWord(token, side, state, options = {}) {
  const directory = options.directory === true
  // `bare` marks an operand an executable treats as a file by position, so a
  // name without an extension or a separator still counts (`cat secret`).
  const bare = options.bare === true
  const raw = String(token?.value ?? '')
  // `find -exec` placeholders and the separators around them are not paths: a
  // lone `{}` would otherwise expand to its literal prefix, the working directory.
  if (raw === '{}' || raw === '{' || raw === '}' || raw === '+' || raw === ';') return
  for (const value of expandWord(token, state)) {
    if (value === '' || value === '-' || value === '--') continue
    if (value === '{}' || value === '{' || value === '}' || value === '+' || value === ';') continue
    if (isNeutralPath(value)) continue
    // A `file://` address points at a local path; every other scheme is remote.
    const local = fileUrlPath(value)
    if (local === undefined && isUrlLike(value)) continue
    const target = local ?? value
    if (bare && (target.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(target))) continue
    // Reading a device is not a question about the workspace; writing one is.
    if (side === 'read' && target.startsWith('/dev/')) continue
    if (!bare && !looksLikePath(target)) continue
    const resolved = local !== undefined ? local : resolveText(target, state.cwd)
    state[side].push(resolved)
    if (side === 'write' && directory) state.directoryWrites.add(resolved)
  }
}

/**
 * Expand one token into the literal paths it could stand for: known variables
 * are substituted (a loop variable yields every value), a glob or brace keeps
 * its literal prefix, and a command substitution yields nothing but marks the
 * containing word as unknown.
 * @param token - one word token.
 * @param state - the running analysis state.
 * @returns the literal paths the word stands for.
 */
export function expandWord(token, state) {
  const raw = String(token?.value ?? '')
  if (raw === '' || raw.includes(UNKNOWN_VALUE)) return []
  let variants = [raw]
  const reference = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g
  for (const variant of [...variants]) {
    if (!reference.test(variant)) continue
    reference.lastIndex = 0
    const grown = []
    let index = 0
    let match = reference.exec(variant)
    while (match !== null) {
      const name = match[1]
      const values = state.vars.get(name)
      if (values === undefined) { grown.length = 0; break }
      grown.push({ head: variant.slice(index, match.index), values })
      index = match.index + match[0].length
      match = reference.exec(variant)
    }
    if (grown.length === 0) { variants = []; continue }
    const tail = variant.slice(index)
    let assembled = ['']
    for (const piece of grown) {
      const next = []
      for (const prefix of assembled) {
        for (const value of piece.values) next.push(`${prefix}${piece.head}${value}`)
      }
      assembled = next
    }
    variants = assembled.map((prefix) => `${prefix}${tail}`)
  }
  return variants
    .map((variant) => {
      if (variant.startsWith('~')) return variant
      const glob = variant.search(/[*?[]/)
      if (glob !== -1) return variant.slice(0, glob) || '.'
      const brace = variant.indexOf('{')
      if (brace !== -1) return variant.slice(0, brace) || '.'
      return variant
    })
    .filter((variant, position, list) => variant !== '' && list.indexOf(variant) === position)
}

/** The directory text a call with no `cd` runs in, as the caller's own base. */
function literalCwd(state) {
  return state.cwdKnown && state.cwd !== undefined ? state.cwd : '.'
}

/** Join one path onto a base unless it is already absolute. */
function resolveText(path, cwd) {
  if (typeof path !== 'string' || path === '') return path
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  if (path.startsWith('~') || cwd === undefined) return path
  return `${String(cwd).replace(/[\\/]+$/, '')}/${path}`
}

/* ------------------------------------------------------- tool calls --- */

/**
 * Collect the filesystem paths one tool call names.
 * @param args - parsed tool arguments.
 * @param options - `includeCwd: false` drops a shell call's working directory, which only names a location.
 * @returns path strings in argument order.
 */
export function extractPaths(args, options = {}) {
  const includeCwd = options.includeCwd !== false
  const found = []
  const walk = (value, key, depth) => {
    if (depth > 4 || value === null || value === undefined) return
    if (PATH_KEYS.has(key)) {
      if (key === 'cwd' && !includeCwd) return
      if (typeof value === 'string' && value !== '') { found.push(value); return }
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string' && item !== '') found.push(item)
        return
      }
    }
    // Tool arguments nest: `present { files: [{ path }] }` names a path one
    // level down, and reading only the top level made it look path-free.
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, depth + 1)
    }
  }
  for (const [key, value] of Object.entries(args ?? {})) walk(value, key, 0)
  return found
}

/**
 * Classify one tool call by the paths it really touches.
 * @param name - wire tool name.
 * @param args - parsed tool arguments.
 * @param options - `root`: the session workspace root, which a search tool with
 * no path argument reads.
 * @returns The operation family with its read and write paths, or `undefined`
 * when the call touches no files.
 */
export function classifyTool(name, args, options = {}) {
  const shape = TOOL_SHAPES[name]
  if (shape === 'shell') {
    const command = typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : ''
    const verdict = analyzeShell(command)
    const named = extractPaths(args, { includeCwd: false })
    const readPaths = dedupe([...verdict.readPaths, ...named])
    const writePaths = dedupe(verdict.writePaths)
    return {
      kind: verdict.kind,
      reason: `${name}:${verdict.reason}`,
      paths: [...writePaths, ...readPaths],
      readPaths,
      writePaths,
      opaque: verdict.opaque,
      targetDirs: verdict.targetDirs ?? [],
      writeDirTargets: verdict.writeDirTargets ?? [],
      command,
    }
  }
  if (shape === 'read' || shape === 'write') {
    const paths = extractPaths(args)
    // A search tool without a path searches the workspace; that is a read of
    // the root, not a call that names nothing.
    if (paths.length === 0 && shape === 'read') {
      const root = options.root
      if (typeof root === 'string' && root !== '' && IMPLICIT_ROOT_TOOLS.has(name)) {
        return {
          kind: 'read',
          reason: `${name}:implicit-root`,
          paths: [root],
          readPaths: [root],
          writePaths: [],
          opaque: false,
        }
      }
    }
    return {
      kind: shape,
      reason: `${name}:declared`,
      paths,
      readPaths: shape === 'read' ? paths : [],
      writePaths: shape === 'write' ? paths : [],
      opaque: false,
    }
  }
  const paths = extractPaths(args)
  if (paths.length === 0) return undefined
  const mutating = Object.keys(args ?? {}).some((key) => WRITE_KEYS.has(key))
  return {
    kind: writePathsOfUnknownTool(mutating) === 'write' ? 'write' : 'read',
    reason: `${name}:${mutating ? 'write-argument' : 'path-argument-unknown-tool'}`,
    paths,
    readPaths: mutating ? [] : paths,
    writePaths: mutating ? paths : [],
    opaque: false,
  }
}

/** The family of an unknown tool call that names paths. */
function writePathsOfUnknownTool(mutating) {
  return mutating ? 'write' : 'read'
}

/* ----------------------------------------------------------- verdicts --- */

/**
 * Resolve one path against a base directory with lexical normalization and
 * decide whether it stays inside a root. Lexical only: `..` is folded, and a
 * symlink that leaves the tree is not detected.
 * @param path - the path the tool call named.
 * @param root - absolute workspace root, or `undefined` when the root is unknown.
 * @param base - directory relative paths resolve against, normally the root.
 * @returns containment verdict; an unknown root never contains anything.
 */
export function containsPath(path, root, base, options = {}) {
  if (typeof root !== 'string' || root === '') {
    return { contained: false, reason: 'no-workspace-root', resolved: path }
  }
  if (typeof path !== 'string' || path.startsWith('~')) {
    return { contained: false, reason: 'unresolvable-path', resolved: path }
  }
  const form = classifyPathForm(path)
  // A device namespace and a drive-relative word name no path this gate can
  // place, so they are refused rather than resolved against a guess.
  if (form === 'device') return { contained: false, reason: 'device-path', resolved: path }
  const windows = options.windows === true
    || process.platform === 'win32'
    || /^[A-Za-z]:[\\/]/.test(root)
    || /^[\\/]{2}/.test(root)
    || root.includes('\\')
  if (windows && form === 'drive-relative') {
    return { contained: false, reason: 'drive-relative', resolved: path }
  }
  const foldedRoot = foldPath(root, { windows })
  if (foldedRoot === undefined) {
    return { contained: false, reason: 'unresolvable-root', resolved: path }
  }
  const foldedBase = foldPath(typeof base === 'string' && base !== '' ? base : root, { windows })
  if (foldedBase === undefined) {
    return { contained: false, reason: 'unresolvable-path', resolved: path }
  }
  const folded = foldPath(path, { windows, base: foldedBase })
  if (folded === undefined) {
    return { contained: false, reason: windows ? 'unresolvable-path' : 'unresolvable-path', resolved: path }
  }
  const compare = (value) => (windows ? value.toLowerCase() : value)
  const rootResolved = compare(foldedRoot)
  const resolved = compare(folded)
  if (resolved === rootResolved) return { contained: true, resolved }
  const boundary = windows ? /[\\/]$/.test(rootResolved) ? '' : '\\' : '/'
  if (resolved.startsWith(`${rootResolved}${boundary}`)) return { contained: true, resolved }
  return { contained: false, resolved, reason: 'outside-workspace' }
}

/**
 * The directory a call's relative paths are resolved against.
 * @param args - parsed tool arguments.
 * @param root - the session workspace root.
 * @returns the absolute scope base; a relative or absent base falls back to the root.
 */
export function scopeBaseOf(args, root) {
  const declared = typeof args?.workdir === 'string' && args.workdir !== ''
    ? args.workdir
    : typeof args?.cwd === 'string' && args.cwd !== ''
      ? args.cwd
      : undefined
  if (declared === undefined) return root
  const absolute = declared.startsWith('/') || /^[A-Za-z]:[\\/]/.test(declared) || declared.startsWith('\\\\')
  if (absolute) return declared
  if (typeof root !== 'string' || root === '') return declared
  return `${root.replace(/[\\/]+$/, '')}/${declared}`
}

/**
 * Decide one side (one family) of one classified tool call against the level.
 *
 * The order is the contract: the level's own verdict comes first, a named
 * allowlist entry outranks the level the way an operator exception outranks a
 * blanket rule, a scope of `none` refuses the family outright before any
 * standing grant is consulted, and only a call whose paths are all inside the
 * workspace — or covered by a grant, or allowed anywhere by the scope — passes
 * without a dialog.
 * @param input - `level`, `kind`, the family's `scope`, whether every named path
 * is `inside`, whether the operator's allowlist `admitted` it, and whether a
 * conversation grant already `granted` it.
 * @returns `allow`, `ask`, or `deny`, with a machine-readable reason.
 */
export function decideSide(input) {
  const { level, kind, scope } = input
  if (level === 'full') return { decision: 'allow', reason: 'level-full' }
  if (input.admitted === true) return { decision: 'allow', reason: 'named-allowlist' }
  if (level === 'none') return { decision: 'deny', reason: 'level-none' }
  if (scope === 'none') return { decision: 'deny', reason: 'level-scope' }
  if (input.granted === true) return { decision: 'allow', reason: `session-grant-${kind}` }
  if (input.inside === true) return { decision: 'allow', reason: 'workspace-path' }
  if (scope === 'anywhere') return { decision: 'allow', reason: `${kind}-scope-anywhere` }
  return { decision: 'ask', reason: `outside-workspace:${kind}` }
}

/**
 * The directory one path stands in, for the purpose of granting it. A path that
 * is already a directory (it ends in a separator, is a drive or share root, is
 * `/`, `.`, or `..`) is returned as it is, so a grant for a directory keeps the
 * whole subtree; anything else falls back to the directory that holds it. A
 * top-level entry stays itself: its parent is the filesystem root, and granting
 * that is never what an answer to one file meant.
 * @param path - an absolute or resolvable path.
 * @returns the directory text.
 */
export function directoryOf(path) {
  if (typeof path !== 'string') return path
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return '/'
  if (trimmed === '/' || /^[A-Za-z]:$/.test(trimmed) || trimmed === '.' || trimmed === '..') return trimmed
  // A trailing separator says the path itself is a directory.
  if (path.endsWith('/') || path.endsWith('\\')) return trimmed
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut === -1) return '.'
  if (cut === 0) return trimmed
  const parent = trimmed.slice(0, cut)
  return /^[A-Za-z]:$/.test(parent) ? trimmed : parent
}

/**
 * Turn one path as a person typed it into the absolute form the plugin stores.
 * Pure and lexical: nothing is looked up, so the caller decides afterwards
 * whether the target exists, is a directory, or is a symlink. The accepted
 * shapes are the ones people actually type or paste: bare paths, quoted paths
 * (single, double, backtick, or Chinese corner quotes, nested), backslash-escaped
 * spaces and quotes, `file://` URLs with percent escapes, `~` and `$HOME`
 * prefixes, Windows separators on Windows, relative paths resolved against the
 * workspace root, and `.` or `..` segments. A trailing separator, or a bare `.`,
 * marks the path as a directory. A drive path (`C:\Users\me`) is rewritten to
 * the mounted directory when the caller knows where the drive lives, which is
 * what makes such a path usable under WSL.
 * @param raw - the typed text.
 * @param options - `root` (workspace root, for relative paths), `home`,
 *   `windows` (whether the host platform is Windows), and `windowsMounts` (an
 *   object mapping an upper-case drive letter to its mount point).
 * @returns `{ path, directory, reason, mapped }`; when nothing usable came out,
 *   `path` is empty and `reason` names why, and `mapped` is true when a drive
 *   path was rewritten to its mount point.
 */
export function normalizeUserPath(raw, options = {}) {
  const refuse = (code) => ({ path: '', directory: false, reason: code })
  if (typeof raw !== 'string') return refuse('not-text')
  let text = raw.trim()
  if (text === '') return refuse('empty')
  if (text.includes('\0')) return refuse('nul')
  if (text.length > 4096) return refuse('too-long')

  // Quotes are peeled from the outside in, so `"/etc/hosts"` and `'"a b"'` both work.
  const pairs = [['"', '"'], ["'", "'"], ['`', '`'], ['「', '」'], ['『', '』']]
  let peeled = true
  while (peeled) {
    peeled = false
    const trimmed = text.trim()
    for (const [open, close] of pairs) {
      if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
        text = trimmed.slice(open.length, trimmed.length - close.length).trim()
        peeled = true
        break
      }
    }
  }
  if (text === '') return refuse('empty')

  // A backslash before a space, a separator, or a quote is an escape, not a name.
  // A UNC path (`\\server\\share`) keeps its double lead: that is a root, not an escape.
  if (!text.startsWith('\\\\')) text = text.replace(/\\([\\ '"`])/g, '$1')

  // A device namespace (`\\?\C:`) and a drive-relative word (`C:foo`) name no
  // file this plugin can place, so both are refused instead of resolved.
  const form = classifyPathForm(text)
  if (form === 'device') return refuse('device-path')
  // `D:` alone still names the root of a mounted drive, so it reaches the mount
  // mapping below; any other `D:foo` is relative to that drive's current folder.
  const bareDrive = /^[A-Za-z]:$/.test(text)
  if (form === 'drive-relative' && !bareDrive) return refuse('drive-relative')

  // `file://` URLs go through the same decoder the shell analysis uses, so the
  // panel and the gate cannot disagree about `file:///C:/x`.
  const fromUrl = text.startsWith('/') || /^[A-Za-z]:/.test(text) ? undefined : fileUrlPath(text)
  if (fromUrl !== undefined) {
    text = fromUrl.trim()
    if (text === '') return refuse('empty')
  } else if (/^file:\/\//i.test(text)) {
    return refuse('bad-url')
  }

  // Under WSL a Windows drive is a mount point (`C:\Users\me` is reachable as
  // `/mnt/c/Users/me`). The caller supplies the mapping; without it the drive
  // path stays a Windows path, as it is on a native Windows host.
  const mounts = options.windowsMounts
  if (options.windows !== true && mounts !== null && typeof mounts === 'object' && !text.startsWith('\\\\')) {
    const drive = /^([A-Za-z]):(.*)$/.exec(text)
    if (drive !== null) {
      const mount = mounts[drive[1].toUpperCase()]
      if (typeof mount === 'string' && mount.startsWith('/')) {
        const tail = drive[2]
        const directory = tail === '' || /[\\/]$/.test(tail) || tail === '.' || tail === '..'
        const segments = []
        for (const part of tail.split(/[\\/]+/)) {
          if (part === '' || part === '.') continue
          if (part === '..') { segments.pop(); continue }
          segments.push(part)
        }
        const base = mount.replace(/\/+$/, '')
        const path = (base === '' ? '' : base) + (segments.length === 0 ? '' : '/' + segments.join('/'))
        return { path: path === '' ? '/' : path, directory, reason: undefined, mapped: true }
      }
    }
  }

  // A bare drive that had no mount mapping cannot be placed either.
  if (classifyPathForm(text) === 'drive-relative') return refuse('drive-relative')
  const windows = options.windows === true || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  if (windows) text = text.replace(/\//g, '\\')

  const home = typeof options.home === 'string' && options.home.trim() !== '' ? options.home.trim() : undefined
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    if (home === undefined) return refuse('no-home')
    text = text === '~' ? home : `${home.replace(/[\\/]+$/, '')}${separator}${text.slice(2)}`
  } else if (/^~[^\\/]/.test(text)) {
    // `~user` names someone else's home, which this plugin never guesses.
    return refuse('unknown-user')
  }
  if (/^\$(?:HOME|\{HOME\})(?=$|[\\/])/i.test(text)) {
    if (home === undefined) return refuse('no-home')
    text = home.replace(/[\\/]+$/, '') + text.replace(/^\$(?:HOME|\{HOME\})/i, '')
  }
  if (text === '') return refuse('empty')

  const directory = text === '.' || text === '..' || text.endsWith('/') || text.endsWith('\\')
  const absolute = windows
    ? text.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(text)
    : text.startsWith('/')
  let joined = text
  if (!absolute) {
    const root = typeof options.root === 'string' ? options.root.trim() : ''
    if (root === '') return refuse('no-root')
    joined = `${root.replace(/[\\/]+$/, '')}${separator}${text}`
  }

  // A backslash separates only on Windows; on POSIX it is an ordinary filename
  // character, so `/home/user/a\\b` stays one segment instead of becoming a folder.
  const parts = joined.split(windows ? /[\\/]+/ : /\//)
  const head = windows ? (parts[0] ?? '') : ''
  const rest = windows ? parts.slice(1) : parts
  const out = []
  for (const part of rest) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  const body = out.join(separator)
  let path
  if (windows) path = text.startsWith('\\\\') ? `\\\\${body}` : `${head}\\${body}`
  else path = `/${body}`
  if (path === '' || (windows && /^[A-Za-z]:$/.test(path))) path = `${path}${separator}`
  return { path, directory, reason: undefined }
}

/**
 * Decide whether one path is covered by the session's read allowlist. An entry
 * covers itself and everything under it, so a directory entry grants its whole
 * subtree; entries may name either a file or a directory. An entry that is
 * itself inside the workspace covers nothing new — the workspace rule already
 * covers it — so only entries reached from outside it are matched.
 * @param path - the path the tool call named.
 * @param allow - the session's read allowlist.
 * @param root - the workspace root, used to resolve relative entries and paths.
 * @param base - the call's working directory for relative paths.
 * @returns the matching entry, or `undefined` when nothing covers the path.
 */
export function allowedBy(path, allow, root, base) {
  if (!Array.isArray(allow) || allow.length === 0) return undefined
  if (typeof path !== 'string' || path === '' || path.startsWith('~')) return undefined
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry === '') continue
    const entryRoot = containsPath(entry, root, root)
    if (entryRoot.contained) continue
    if (containsPath(path, entry, base).contained) return entry
  }
  return undefined
}

/**
 * Read the read-allowlist strings out of one stored session value.
 * @param value - stored state for one session.
 * @returns the allowlist, always an array.
 */
export function allowListOf(value) {
  if (value === null || typeof value !== 'object') return []
  return Array.isArray(value.allow)
    ? value.allow.filter((entry) => typeof entry === 'string' && entry !== '')
    : []
}

/**
 * Validate one configured level name.
 * @param value - candidate level.
 * @returns whether the value is a supported level.
 */
export function isLevel(value) {
  return LEVELS.includes(value)
}
