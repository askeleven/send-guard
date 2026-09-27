import { formatCsv } from './input.js'

/**
 * The addresses worth sending to, in the same shape they arrived: a CSV keeps its
 * header and every other column, a plain list stays one address per line.
 *
 * @param {import('./input.js').ParsedInput} input
 * @param {import('./index.js').Report} report Checked from input.addresses, in order.
 * @param {{ includeReview?: boolean }} [options]
 * @returns {string}
 */
export function writeClean(input, report, options = {}) {
  const wanted = (/** @type {import('./index.js').AddressResult} */ r) =>
    r.verdict === 'keep' || (options.includeReview === true && r.verdict === 'review')

  const kept = input.rows.filter((_, i) => wanted(report.addresses[i]))

  if (input.format === 'lines') return kept.map((row) => `${row[0]}\n`).join('')
  return formatCsv(input.header ? [input.header, ...kept] : kept, input.delimiter)
}
