import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SKIP_FLAGS = new Set(['--json', '--quiet', '-q', '--help', '-h', '--version', '-v'])

/**
 * One line after a successful run, pointing at the GitHub repo. Shown on
 * standard error only when a person is at an interactive terminal, at most
 * once a week per tool. Never in CI, in --json or --quiet runs, for --help or
 * --version, or when the tool runs as an MCP server. Turn it off with
 * ASKELEVEN_NO_STAR=1 (NO_UPDATE_NOTIFIER is honored too).
 *
 * @param {string} tool    The repo name, such as "prompt-fence".
 * @param {number} code    The exit code the command returned.
 * @param {string[]} argv  The command-line arguments.
 * @param {{ now?: number, env?: NodeJS.ProcessEnv, tty?: boolean, stateDir?: string, write?: (s: string) => void }} [deps]
 * @returns {boolean} whether the line was printed
 */
export function starHint(tool, code, argv, deps = {}) {
  try {
    const env = deps.env ?? process.env
    const tty = deps.tty ?? (process.stdout.isTTY === true && process.stderr.isTTY === true)
    if (code !== 0 || !tty) return false
    if (env.CI || env.ASKELEVEN_NO_STAR || env.NO_UPDATE_NOTIFIER) return false
    if (argv[0] === 'mcp' || argv.some((a) => SKIP_FLAGS.has(a))) return false

    const now = deps.now ?? Date.now()
    const dir = deps.stateDir ?? join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'askeleven')
    const stamp = join(dir, `${tool}.star-hint`)
    let last = 0
    try {
      last = Number(readFileSync(stamp, 'utf8')) || 0
    } catch {}
    if (now - last < WEEK_MS) return false
    mkdirSync(dir, { recursive: true })
    writeFileSync(stamp, String(now))

    const plain = env.NO_COLOR || argv.includes('--no-colour') || argv.includes('--no-color')
    const line = `Useful? A star helps others find it: https://github.com/askeleven/${tool}  (hide: ASKELEVEN_NO_STAR=1)`
    ;(deps.write ?? ((s) => process.stderr.write(s)))(`\n${plain ? line : `\x1b[2m${line}\x1b[0m`}\n`)
    return true
  } catch {
    // A hint must never break the tool.
    return false
  }
}
