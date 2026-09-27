/**
 * @typedef {object} ParsedInput
 * @property {'lines'|'csv'} format
 * @property {string[]} addresses One per data row, as written (not normalised).
 * @property {string[][]} rows The data rows as parsed, parallel to addresses. For
 *   'lines' input each row is the single line.
 * @property {string[] | null} header The CSV header row, when there is one.
 * @property {string} delimiter
 * @property {number} skipped Data rows with no value in the email column.
 */

/**
 * Reads a list the way exports actually arrive: a plain file with one address per
 * line, or a CSV (comma, semicolon, or tab separated) with or without a header. Every
 * non-empty line in a plain file counts, including ones that are not addresses, so
 * malformed entries are reported rather than silently dropped.
 *
 * @param {string} text
 * @param {{ column?: string }} [options] Header name or 1-based column number.
 * @returns {ParsedInput}
 */
export function parseInput(text, options = {}) {
  const body = text.replace(/^﻿/, '')
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = detectDelimiter(firstLine)

  if (!delimiter && !options.column) {
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // A lone header line such as "email" is not an address to check.
    if (lines.length && /^e-?mail(\s*address)?$/i.test(lines[0])) lines.shift()
    return {
      format: 'lines',
      addresses: lines,
      rows: lines.map((l) => [l]),
      header: null,
      delimiter: ',',
      skipped: 0,
    }
  }

  const sep = delimiter ?? ','
  const table = parseCsv(body, sep).filter((r) => r.some((c) => c.trim() !== ''))
  if (table.length === 0) {
    return { format: 'csv', addresses: [], rows: [], header: null, delimiter: sep, skipped: 0 }
  }

  const first = table[0]
  const hasHeader = !first.some((c) => c.includes('@'))
  const header = hasHeader ? first : null
  const data = hasHeader ? table.slice(1) : table

  const index = pickColumn(header, data, options.column)

  /** @type {string[]} */
  const addresses = []
  /** @type {string[][]} */
  const rows = []
  let skipped = 0
  for (const row of data) {
    const value = (row[index] ?? '').trim()
    if (!value) {
      skipped++
      continue
    }
    addresses.push(value)
    rows.push(row)
  }

  return { format: 'csv', addresses, rows, header, delimiter: sep, skipped }
}

/**
 * @param {string[] | null} header
 * @param {string[][]} data
 * @param {string | undefined} column
 * @returns {number}
 */
function pickColumn(header, data, column) {
  if (column) {
    if (/^\d+$/.test(column)) {
      const n = Number(column)
      if (n < 1) throw new Error(`Column numbers start at 1, got ${column}.`)
      return n - 1
    }
    const found = header?.findIndex((h) => h.trim().toLowerCase() === column.toLowerCase())
    if (found === undefined || found === -1) {
      throw new Error(
        header
          ? `No column named "${column}". Columns: ${header.map((h) => h.trim()).join(', ')}`
          : `No header row, so "${column}" cannot be matched. Pass a column number.`,
      )
    }
    return found
  }

  if (header) {
    const named = header.findIndex((h) => /^e-?mail(\s*address)?$/i.test(h.trim()))
    if (named !== -1) return named
    const loose = header.findIndex((h) => /e-?mail/i.test(h))
    if (loose !== -1) return loose
  }

  // No usable header: take the column that most often holds something with an '@'.
  /** @type {number[]} */
  const counts = []
  for (const row of data.slice(0, 200)) {
    row.forEach((cell, i) => {
      if (cell.includes('@')) counts[i] = (counts[i] ?? 0) + 1
    })
  }
  let best = -1
  counts.forEach((c, i) => {
    if (best === -1 || c > counts[best]) best = i
  })
  if (best === -1) {
    throw new Error('Could not find an email column. Pass --column with its name or number.')
  }
  return best
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function detectDelimiter(line) {
  /** @type {[string, number][]} */
  const counts = [',', ';', '\t'].map((d) => [d, countOutsideQuotes(line, d)])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : null
}

/**
 * @param {string} line
 * @param {string} char
 * @returns {number}
 */
function countOutsideQuotes(line, char) {
  let quoted = false
  let n = 0
  for (const c of line) {
    if (c === '"') quoted = !quoted
    else if (c === char && !quoted) n++
  }
  return n
}

/**
 * RFC 4180 parsing: quoted fields, doubled quotes, newlines inside quotes.
 *
 * @param {string} text
 * @param {string} sep
 * @returns {string[][]}
 */
export function parseCsv(text, sep) {
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
    } else if (c === '"' && field === '') {
      quoted = true
    } else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * @param {string[][]} rows
 * @param {string} sep
 * @returns {string}
 */
export function formatCsv(rows, sep) {
  const cell = (/** @type {string} */ v) =>
    /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v
  return rows.map((r) => r.map(cell).join(sep)).join('\n') + (rows.length ? '\n' : '')
}
