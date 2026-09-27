#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  checkList,
  createClient,
  createResolver,
  parseInput,
  GuardError,
  AnalyzemailError,
  DEFAULT_MAX_REMOVE_PERCENT,
  DEFAULT_MAX_CREDITS,
} from '../src/index.js'
import { formatText } from '../src/report.js'
import { writeClean } from '../src/output.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'

const USAGE = `
send-guard <list.csv | list.txt | address ...>
send-guard mcp

  Checks an email list before you send to it, and says whether it is safe to.
  Syntax, duplicates, disposable and role inboxes, typos, and domains that cannot
  receive mail are checked locally for free. With ANALYZEMAIL_API_KEY set, whatever
  survives is also checked at the mailbox (one credit per address).

Options
  --column <name|n>     Email column in a CSV. Found automatically otherwise.
  --max-remove <pct>    Fail when more than this share of the list should be
                        removed. Default ${DEFAULT_MAX_REMOVE_PERCENT}.
  --max-credits <n>     Refuse to spend more than this on mailbox checks.
                        Default ${DEFAULT_MAX_CREDITS}.
  --out <file>          Write the addresses to keep, in the input's format.
  --include-review      Also write addresses marked review to --out.
  --no-mailbox          Local checks only, even with an API key set.
  --no-dns              Skip DNS lookups. Syntax and list checks only.
  --dns <ip>            Resolver to query. Repeatable.
  --json                Machine-readable output.
  --all                 List every flagged address, not the first ten per reason.
  --no-colour           Plain text.
  --version, --help

  Reads standard input when given no file or given "-".

Environment
  ANALYZEMAIL_API_KEY   Enables mailbox checks. Get one at analyzemail.com.

Exit codes
  0  safe to send (removals at or under --max-remove)
  1  not safe to send as it stands
  2  could not run

Examples
  npx @askeleven/send-guard leads.csv
  npx @askeleven/send-guard leads.csv --out clean.csv --json
  cat list.txt | npx @askeleven/send-guard --no-mailbox
  npx @askeleven/send-guard mcp       # MCP server over stdio, for agents
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  if (argv[0] === 'mcp') {
    await serve()
    return 0
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        column: { type: 'string' },
        'max-remove': { type: 'string' },
        'max-credits': { type: 'string' },
        out: { type: 'string' },
        'include-review': { type: 'boolean', default: false },
        'no-mailbox': { type: 'boolean', default: false },
        'no-dns': { type: 'boolean', default: false },
        dns: { type: 'string', multiple: true },
        json: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const maxRemovePercent = numberOption(values['max-remove'], DEFAULT_MAX_REMOVE_PERCENT, '--max-remove')
  const maxCredits = numberOption(values['max-credits'], DEFAULT_MAX_CREDITS, '--max-credits')
  if (maxRemovePercent === null || maxCredits === null) return 2

  let input
  try {
    input = await readInput(positionals, values.column)
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }
  if (input.addresses.length === 0) {
    process.stderr.write(`No addresses found.\n${USAGE}`)
    return 2
  }

  const apiKey = process.env.ANALYZEMAIL_API_KEY
  const showProgress = !values.json && process.stderr.isTTY === true

  let report
  try {
    report = await checkList(input.addresses, {
      dns: !values['no-dns'],
      resolver: values.dns?.length ? createResolver({ servers: values.dns }) : undefined,
      client: apiKey && !values['no-mailbox'] ? createClient({ apiKey }) : undefined,
      maxCredits,
      maxRemovePercent,
      onProgress: showProgress
        ? (done, total) => {
            process.stderr.write(`\rChecking mailboxes ${done}/${total}`)
            if (done === total) process.stderr.write('\r\x1b[K')
          }
        : undefined,
    })
  } catch (error) {
    if (error instanceof GuardError || error instanceof AnalyzemailError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }

  if (values.out) {
    await writeFile(values.out, writeClean(input, report, { includeReview: values['include-review'] }))
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      formatText(report, { colour: useColour(values), limit: values.all ? 0 : 10 }),
    )
    if (values.out) process.stdout.write(`Wrote the addresses to keep to ${values.out}\n\n`)
  }

  return report.summary.passed ? 0 : 1
}

/**
 * Positionals are files, "-" for standard input, or addresses typed inline.
 *
 * @param {string[]} positionals
 * @param {string | undefined} column
 * @returns {Promise<import('../src/input.js').ParsedInput>}
 */
async function readInput(positionals, column) {
  if (positionals.length === 0 || (positionals.length === 1 && positionals[0] === '-')) {
    if (process.stdin.isTTY) throw new Error(`Give a file, some addresses, or pipe a list in.\n${USAGE}`)
    return parseInput(await readStdin(), { column })
  }

  const files = positionals.filter((p) => p !== '-' && existsSync(p))
  if (files.length > 1) throw new Error('Check one file at a time.')
  if (files.length === 1) {
    if (positionals.length > 1) throw new Error('Give either a file or addresses, not both.')
    return parseInput(await readFile(files[0], 'utf8'), { column })
  }

  const missing = positionals.find((p) => !p.includes('@'))
  if (missing) throw new Error(`No such file: ${missing}`)
  return parseInput(positionals.join('\n'))
}

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @returns {number | null}
 */
function numberOption(raw, fallback, name) {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`${name} must be a number of zero or more, got ${raw}\n`)
    return null
  }
  return n
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
