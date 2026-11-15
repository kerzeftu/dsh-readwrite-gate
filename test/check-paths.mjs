/**
 * Lexical path model: the forms a path can take, how they fold, and how a
 * `file:` URL becomes one. Every case here is pure text, so the suite runs the
 * same on Linux, macOS and Windows and never touches the filesystem.
 *
 * The Windows rules are exercised through the explicit `windows` option, which
 * is what the gate passes when it sees a drive or share path on a POSIX host.
 */
import {
  classifyPathForm,
  containsPath,
  fileUrlPath,
  foldPath,
  normalizeUserPath,
} from '../functions.js'

let failures = 0
const say = (line) => process.stdout.write(`${line}\n`)
function check(label, actual, expected) {
  let ok
  try {
    ok = JSON.stringify(actual) === JSON.stringify(expected)
  } catch {
    ok = false
  }
  if (!ok) failures += 1
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

// ---------------------------------------------------------------- forms
check('a rooted POSIX word is a root path', classifyPathForm('/etc/hosts'), 'root')
check('a drive path with a separator is a drive path', classifyPathForm('C:\\Users\\me'), 'drive')
check('a drive path with a slash is a drive path', classifyPathForm('C:/Users/me'), 'drive')
check('a drive without a separator is drive-relative', classifyPathForm('C:work'), 'drive-relative')
check('a UNC path is a share root', classifyPathForm('\\\\server\\share\\x'), 'unc')
check('a slash-written share is a share root', classifyPathForm('//server/share/x'), 'unc')
check('a device namespace is a device path', classifyPathForm('\\\\?\\C:\\x'), 'device')
check('the device namespace of a volume is a device path', classifyPathForm('\\\\.\\PhysicalDrive0'), 'device')
check('a plan word is relative', classifyPathForm('notes.txt'), 'relative')

// ---------------------------------------------------------------- file URLs
check('file:///etc/hosts names a rooted path', fileUrlPath('file:///etc/hosts'), '/etc/hosts')
check('a drive in a file URL becomes a drive path', fileUrlPath('file:///C:/Users/me'), 'C:/Users/me')
check('the localhost host is the local machine', fileUrlPath('file://localhost/etc/hosts'), '/etc/hosts')
check('a remote host in a file URL becomes a share', fileUrlPath('file://server/share/x'), '//server/share/x')
check('percent escapes are decoded', fileUrlPath('file:///home/user/a%20b'), '/home/user/a b')
check('a bare file root stays rooted', fileUrlPath('file:///'), '/')
check('an http URL is not a file URL', fileUrlPath('http://example.com/x'), undefined)

// ---------------------------------------------------------------- folding
check('a drive keeps its root while folding up', foldPath('C:\\a\\..\\..\\b', { windows: true }), 'C:\\b')
check('a share keeps its two anchor segments', foldPath('\\\\srv\\share\\a\\..\\..\\..\\b', { windows: true }), '\\\\srv\\share\\b')
check('a rooted Windows word borrows the base drive', foldPath('\\temp\\x', { windows: true, base: 'C:\\work' }), 'C:\\temp\\x')
check('a rooted Windows word borrows the base share', foldPath('\\temp\\x', { windows: true, base: '\\\\srv\\share\\ws' }), '\\\\srv\\share\\temp\\x')
check('a relative Windows word joins the base', foldPath('a\\b', { windows: true, base: 'C:\\work' }), 'C:\\work\\a\\b')
check('a drive-relative word cannot be placed', foldPath('C:work', { windows: true, base: 'C:\\work' }), undefined)
check('a device path cannot be placed', foldPath('\\\\?\\C:\\x', { windows: true, base: 'C:\\work' }), undefined)
check('a POSIX backslash is a filename character', foldPath('/home/user/a\\b'), '/home/user/a\\b')
check('a POSIX root is not climbable', foldPath('/a/../../b'), '/b')
check('a relative POSIX word joins the base', foldPath('../x', { base: '/home/user/ws' }), '/home/user/x')

// ---------------------------------------------------------------- containment
const WIN = { windows: true }
check('a child of a drive root is inside', containsPath('C:\\work\\a.txt', 'C:\\work', undefined, WIN).contained, true)
check('a sibling with the same prefix is outside', containsPath('C:\\work2\\a.txt', 'C:\\work', undefined, WIN).contained, false)
check('drive containment ignores case', containsPath('c:\\WORK\\A.TXT', 'C:\\work', undefined, WIN).contained, true)
check('a child of a share root is inside', containsPath('\\\\srv\\share\\sub\\x', '\\\\srv\\share', undefined, WIN).contained, true)
check('another share on the same server is outside', containsPath('\\\\srv\\other\\x', '\\\\srv\\share', undefined, WIN).contained, false)
check('climbing out of a share stays at the share', containsPath('\\\\srv\\share\\..\\..\\other\\x', '\\\\srv\\share', undefined, WIN).contained, true)
check('a drive-relative word is refused', containsPath('C:work\\a', 'C:\\work', undefined, WIN).reason, 'drive-relative')
check('a device path is refused', containsPath('\\\\?\\C:\\x', 'C:\\work', undefined, WIN).reason, 'device-path')
check('a POSIX backslash does not create a child path', containsPath('/etc\\passwd', '/etc', undefined).contained, false)
check('a POSIX parent step leaves the root', containsPath('../x', '/home/user/ws', undefined).contained, false)

// ---------------------------------------------------------------- one decoder
check('a file URL and its plain form agree for a drive',
  normalizeUserPath('file:///C:/Users/me', { windows: true }),
  normalizeUserPath('C:/Users/me', { windows: true }))
check('a file URL and its plain form agree for a share',
  normalizeUserPath('file://server/share/x', { windows: true }),
  normalizeUserPath('\\\\server\\share\\x', { windows: true }))
check('a file URL and its plain form agree on POSIX',
  normalizeUserPath('file:///etc/hosts'),
  normalizeUserPath('/etc/hosts'))
check('a device path is refused by the panel too',
  normalizeUserPath('\\\\?\\C:\\x', { windows: true }).reason, 'device-path')
check('a drive-relative word is refused by the panel too',
  normalizeUserPath('C:work', { windows: true }).reason, 'drive-relative')
check('a POSIX backslash survives a manual entry',
  normalizeUserPath('/home/user/a\\b').path, '/home/user/a\\b')

say(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)
