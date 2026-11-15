/**
 * Run every suite and report one summary line per suite.
 *
 * Each suite prints its own detail and exits non-zero on failure; this runner
 * only aggregates. `AP_CLIENT` / `AP_DSH_DIR` are passed through to the suites
 * that understand them.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const suites = [
  'check-locale.mjs',
  'check-panel.mjs',
  'check-menu.mjs',
  'check-visual.mjs',
  'check-seat.mjs',
  'check-gate.mjs',
  'check-paths.mjs',
  'delegation.test.mjs',
]

let failed = 0
for (const suite of suites) {
  const file = fileURLToPath(new URL(suite, import.meta.url))
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  // Prefer stdout: the plugin logs an expected DOM failure to stderr.
  const detail = `${(run.stdout ?? '').trim() !== '' ? run.stdout : (run.stderr ?? '')}`.split('\n')
  // Stack frames are noise here: a suite may log an expected failure (the DOM
  // stub has no `querySelector`) and still pass.
  const lines = detail.filter((line) => line.trim() !== '' && !/^\s+at /.test(line))
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : '(no output)'
  const ok = run.status === 0
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${suite.padEnd(22)} ${last}\n`)
  if (!ok && lines.length > 1) process.stdout.write(lines.slice(-12).map((line) => `     ${line}`).join('\n') + '\n')
}

process.stdout.write(`\n${failed === 0 ? 'ALL SUITES PASS' : `${failed} SUITE(S) FAILED`}\n`)
process.exit(failed === 0 ? 0 : 1)
