/**
 * @typedef {import('./index.js').Report} Report
 * @typedef {import('./index.js').AddressResult} AddressResult
 * @typedef {import('./index.js').ReasonCode} ReasonCode
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
}

/** Headings for each reason, in the order they are listed. */
const REASON_TITLES = /** @type {Record<ReasonCode, string>} */ ({
  syntax: 'Invalid address',
  no_mail_domain: 'Domain cannot receive mail',
  null_mx: 'Domain refuses all mail',
  parked: 'Parked domain',
  mailbox_undeliverable: 'Mailbox does not exist',
  trap: 'Spam trap',
  litigator: 'Known litigator',
  disposable: 'Disposable inbox',
  typo: 'Probable typo',
  duplicate: 'Duplicate',
  role: 'Shared inbox (role account)',
  catch_all: 'Catch-all domain',
  protected: 'Mailbox status hidden',
  mailbox_risky: 'Rated risky',
  mailbox_unknown: 'Mail server did not answer',
  dns_error: 'DNS lookup failed',
  free: 'Free provider',
})

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} indent
 * @returns {string}
 */
function wrap(text, width, indent) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

/**
 * @param {Report} report
 * @param {{ colour?: boolean, width?: number, limit?: number }} [options] limit caps
 *   the addresses shown per reason; 0 shows all.
 * @returns {string}
 */
export function formatText(report, options = {}) {
  const { colour = true, width = 76, limit = 10 } = options
  const paint = painter(colour)
  const { summary } = report
  const lines = ['']

  const verdict = summary.passed
    ? paint(COLOURS.green, 'PASS')
    : paint(COLOURS.red, 'FAIL')
  lines.push(
    `${verdict}  ${paint(COLOURS.bold, `${summary.removePercent}% of the list should be removed`)}` +
      paint(COLOURS.dim, ` (limit ${summary.maxRemovePercent}%)`),
  )
  lines.push('')
  lines.push(`      ${String(summary.total).padStart(6)} checked`)
  lines.push(`      ${paint(COLOURS.green, String(summary.keep).padStart(6))} keep`)
  lines.push(`      ${paint(COLOURS.yellow, String(summary.review).padStart(6))} review`)
  lines.push(
    `      ${paint(COLOURS.red, String(summary.remove).padStart(6))} remove` +
      (summary.duplicates ? paint(COLOURS.dim, ` (${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'})`) : ''),
  )
  if (summary.mailboxCheck !== 'skipped') {
    lines.push(
      paint(
        COLOURS.dim,
        `      Mailbox check ${summary.mailboxCheck}, ${summary.creditsUsed} credit` +
          `${summary.creditsUsed === 1 ? '' : 's'} used`,
      ),
    )
  }

  for (const verdictName of /** @type {const} */ (['remove', 'review'])) {
    /** @type {Map<ReasonCode, AddressResult[]>} */
    const groups = new Map()
    for (const r of report.addresses) {
      if (r.verdict !== verdictName) continue
      // File each address under its first reason at this verdict, so it appears once.
      const reason = r.reasons.find((x) => x.verdict === verdictName)
      if (!reason) continue
      const list = groups.get(reason.code) ?? []
      list.push(r)
      groups.set(reason.code, list)
    }
    if (groups.size === 0) continue

    lines.push('')
    lines.push(
      paint(
        verdictName === 'remove' ? COLOURS.red : COLOURS.yellow,
        verdictName === 'remove' ? 'REMOVE' : 'REVIEW',
      ),
    )
    const ordered = [...groups.entries()].sort(
      ([a], [b]) =>
        Object.keys(REASON_TITLES).indexOf(a) - Object.keys(REASON_TITLES).indexOf(b),
    )
    for (const [code, list] of ordered) {
      lines.push(`  ${paint(COLOURS.bold, REASON_TITLES[code])} ${paint(COLOURS.dim, `(${list.length})`)}`)
      const shown = limit > 0 ? list.slice(0, limit) : list
      for (const r of shown) {
        const hint = r.suggestion ? paint(COLOURS.dim, `  did you mean ${r.suggestion}?`) : ''
        lines.push(`      ${r.input}${hint}`)
      }
      if (shown.length < list.length) {
        lines.push(paint(COLOURS.dim, `      and ${list.length - shown.length} more (--all to list them)`))
      }
    }
  }

  if (report.notes.length) {
    lines.push('')
    for (const note of report.notes) lines.push(paint(COLOURS.dim, wrap(note, width - 2, '  ')))
  }

  lines.push('')
  return lines.join('\n')
}
