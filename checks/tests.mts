// Holds every test in the repository to CONTRIBUTING.md's Tests bar, wherever it lives: `pnpm lint` runs this.
//
// - A test is TypeScript, so it is type-checked: no JavaScript file is a test or sits in a test folder.
// - A test waits on the event it needs, never on time: no `setTimeout`, `setInterval` or `setImmediate` (bare or
//   through `globalThis`), `AbortSignal.timeout` or `node:timers` import outside relay/test/support/backstop.mts,
//   the one backstop that ends a hung run. A spawned process's `timeout` and a test's `timeout` are backstops too.
//   A line check, against mistakes: a computed key gets past it, and review catches that.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BACKSTOP = 'relay/test/support/backstop.mts'
const TIMERS = [/\bset(Timeout|Interval|Immediate)\b/, /\bAbortSignal\s*\.\s*timeout\b/, /['"`](node:)?timers(\/promises)?['"`]/]

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
const isTest = (file: string) => /(^|\/)tests?\//.test(file) || /\.test\.[^/]+$/.test(file)
const tests = files.filter(isTest)

const problems: string[] = []
for (const file of tests.filter((f) => /\.[cm]?jsx?$/.test(f))) problems.push(`${file}: a test is TypeScript (.mts, .ts or .tsx), so it is type-checked`)
for (const file of tests.filter((f) => /\.(m|c)?tsx?$/.test(f) && f !== BACKSTOP)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const code = line.trimStart()
      if (code.startsWith('//') || code.startsWith('*')) return
      if (TIMERS.some((timer) => timer.test(line)))
        problems.push(`${file}:${i + 1}: a test waits on the event it needs, not on time; a backstop goes through ${BACKSTOP}`)
    })
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`)
  process.exit(1)
}
