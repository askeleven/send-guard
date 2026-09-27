import { createInterface } from 'node:readline'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  checkList,
  createClient,
  GuardError,
  DEFAULT_MAX_REMOVE_PERCENT,
  DEFAULT_MAX_CREDITS,
} from './index.js'
import { AnalyzemailError } from './analyzemail.js'
import { parseInput } from './input.js'
import { writeClean } from './output.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Addresses in one check_emails call. Past this, write a file and use check_file. */
const MAX_INLINE = 5000
/** Kept addresses returned inline by check_file when no out_path is given. */
const MAX_KEEP_RETURNED = 2000
const MAX_FILE_BYTES = 50 * 1024 * 1024

const INSTRUCTIONS =
  'Call send-guard before sending email to any list you did not build address by ' +
  'address yourself. If passed is false, do not send to the list as it stands: send ' +
  'only to the keep addresses, and show the person the review addresses rather than ' +
  'deciding for them. Never re-add a removed address. A removed address with a ' +
  'suggestion is a probable typo: offer the suggestion to the person, do not substitute it.'

const COMMON_PROPERTIES = {
  max_remove_percent: {
    type: 'number',
    minimum: 0,
    maximum: 100,
    description: `Fail when more than this share of distinct addresses should be removed. Default ${DEFAULT_MAX_REMOVE_PERCENT}.`,
  },
  check_mailboxes: {
    type: 'boolean',
    description:
      'Check that each mailbox exists, via Analyzemail. Needs ANALYZEMAIL_API_KEY in the ' +
      'server environment and costs one credit per distinct address that passes the free ' +
      'local checks. Default true when a key is set.',
  },
  max_credits: {
    type: 'integer',
    minimum: 0,
    description: `Refuse to start mailbox checks that would spend more than this. Default ${DEFAULT_MAX_CREDITS}.`,
  },
}

const TOOLS = [
  {
    name: 'check_emails',
    title: 'Check email addresses before sending',
    description:
      'Checks addresses before you send to them. Returns passed (whether the list is safe ' +
      'to send to as it stands), the addresses to keep, the ones to remove with the ' +
      'reason, and the ones a person should review. Local checks are free: syntax, ' +
      'duplicates, disposable and role inboxes, typos of major providers, domains with no ' +
      'mail servers or parked for sale. Mailbox, catch-all, spam-trap and litigator ' +
      `checks need an Analyzemail API key. Up to ${MAX_INLINE} addresses per call.`,
    inputSchema: {
      type: 'object',
      properties: {
        emails: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_INLINE,
          description: 'The addresses, as they appear in the list.',
        },
        ...COMMON_PROPERTIES,
      },
      required: ['emails'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'check_file',
    title: 'Check an email list file before sending',
    description:
      'Same checks as check_emails, for a CSV or plain-text list on disk. The email ' +
      'column is found automatically. With out_path, writes the addresses to keep in the ' +
      'same format, other columns included, and that file is what you should send to.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The list file.' },
        column: {
          type: 'string',
          description: 'Email column header or 1-based number, if detection picks wrong.',
        },
        out_path: { type: 'string', description: 'Where to write the addresses to keep.' },
        include_review: {
          type: 'boolean',
          description: 'Also write review addresses to out_path. Default false.',
        },
        ...COMMON_PROPERTIES,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
]

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 * @property {Record<string, string | undefined>} [env]
 * @property {Partial<import('./index.js').CheckOptions>} [checkOptions] Overrides for
 *   tests, such as a fixture resolver or a fake client.
 */

/**
 * Serves until the input stream closes.
 *
 * @param {ServeOptions} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  /** @type {Promise<void>[]} */
  const pending = []
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    pending.push(handleLine(line, send, options))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      Promise.all(pending).then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @param {ServeOptions} options
 * @returns {Promise<void>}
 */
async function handleLine(line, send, options) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.

  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {}, options)
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} method
 * @param {any} params
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function dispatch(method, params, options) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'send-guard', title: 'send-guard', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {}, options)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message and can act on it.
 *
 * @param {string} name
 * @param {any} args
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function callTool(name, args, options) {
  if (name !== 'check_emails' && name !== 'check_file') {
    throw new RpcError(-32602, `Unknown tool: ${name}`)
  }
  try {
    const payload =
      name === 'check_emails' ? await checkEmails(args, options) : await checkFile(args, options)
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    }
  } catch (error) {
    if (
      error instanceof GuardError ||
      error instanceof AnalyzemailError ||
      error instanceof ToolInputError
    ) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    throw error
  }
}

class ToolInputError extends Error {}

/**
 * @param {any} args
 * @param {ServeOptions} options
 */
async function checkEmails(args, options) {
  const emails = args.emails
  if (!Array.isArray(emails) || emails.length === 0 || emails.some((e) => typeof e !== 'string')) {
    throw new ToolInputError('emails must be a non-empty array of strings.')
  }
  if (emails.length > MAX_INLINE) {
    throw new ToolInputError(
      `${emails.length} addresses is over the ${MAX_INLINE} per call. Write them to a file and use check_file.`,
    )
  }
  const report = await run(emails, args, options)
  return shape(report, { includeKeep: true })
}

/**
 * @param {any} args
 * @param {ServeOptions} options
 */
async function checkFile(args, options) {
  if (typeof args.path !== 'string' || !args.path) throw new ToolInputError('path is required.')
  const path = resolve(args.path)

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new ToolInputError(`No such file: ${path}`)
  if (info.size > MAX_FILE_BYTES) throw new ToolInputError(`${path} is over 50 MB.`)

  let input
  try {
    input = parseInput(await readFile(path, 'utf8'), { column: args.column })
  } catch (error) {
    throw new ToolInputError(/** @type {Error} */ (error).message)
  }
  if (input.addresses.length === 0) throw new ToolInputError(`No addresses found in ${path}.`)

  const report = await run(input.addresses, args, options)

  if (typeof args.out_path === 'string' && args.out_path) {
    const outPath = resolve(args.out_path)
    if (outPath === path) throw new ToolInputError('out_path must not be the input file.')
    await writeFile(outPath, writeClean(input, report, { includeReview: args.include_review === true }))
    return { ...shape(report, { includeKeep: false }), out_path: outPath }
  }
  const includeKeep = report.summary.keep <= MAX_KEEP_RETURNED
  const shaped = shape(report, { includeKeep })
  if (!includeKeep) {
    shaped.notes = [
      ...shaped.notes,
      `The ${report.summary.keep} addresses to keep are too many to return inline. ` +
        'Call again with out_path to write them to a file.',
    ]
  }
  return shaped
}

/**
 * @param {string[]} emails
 * @param {any} args
 * @param {ServeOptions} options
 */
async function run(emails, args, options) {
  const env = options.env ?? process.env
  const apiKey = env.ANALYZEMAIL_API_KEY
  const wantMailboxes = args.check_mailboxes !== false
  return checkList(emails, {
    client: apiKey && wantMailboxes ? createClient({ apiKey }) : undefined,
    maxRemovePercent: typeof args.max_remove_percent === 'number' ? args.max_remove_percent : undefined,
    maxCredits: typeof args.max_credits === 'number' ? args.max_credits : undefined,
    ...options.checkOptions,
  })
}

/**
 * A compact view for a model: the verdict, the lists it needs to act on, and nothing
 * repeated per address that the summary already says.
 *
 * @param {import('./index.js').Report} report
 * @param {{ includeKeep: boolean }} options
 */
function shape(report, options) {
  const pick = (/** @type {import('./index.js').Verdict} */ verdict) =>
    report.addresses
      .filter((r) => r.verdict === verdict)
      .map((r) => ({
        email: r.input,
        reasons: r.reasons.filter((x) => x.verdict === verdict).map((x) => x.code),
        detail: r.reasons.find((x) => x.verdict === verdict)?.detail,
        ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      }))

  return {
    passed: report.summary.passed,
    summary: report.summary,
    remove: pick('remove'),
    review: pick('review'),
    ...(options.includeKeep
      ? { keep: report.addresses.filter((r) => r.verdict === 'keep').map((r) => r.input) }
      : {}),
    notes: report.notes,
  }
}
