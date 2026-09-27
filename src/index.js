import {
  normaliseAddress,
  splitAddress,
  asciiDomain,
  isValidSyntax,
  disposableMatch,
  isRole,
  isFree,
  typoSuggestion,
} from './address.js'
import { checkDomain } from './domain.js'
import { createResolver } from './resolver.js'
import { AnalyzemailError, API_KEY_URL, CREDITS_URL } from './analyzemail.js'

export { createResolver, createFixtureResolver } from './resolver.js'
export {
  createClient,
  AnalyzemailError,
  DEFAULT_API_URL,
  API_KEY_URL,
  CREDITS_URL,
} from './analyzemail.js'
export { parseInput, formatCsv } from './input.js'
export { normaliseAddress, isValidSyntax, typoSuggestion } from './address.js'

/**
 * @typedef {import('./resolver.js').DnsResolver} DnsResolver
 * @typedef {import('./analyzemail.js').AnalyzemailClient} AnalyzemailClient
 * @typedef {import('./analyzemail.js').Verification} Verification
 *
 * @typedef {'keep'|'review'|'remove'} Verdict
 *
 * @typedef {'syntax'|'duplicate'|'disposable'|'no_mail_domain'|'null_mx'|'parked'
 *   |'mailbox_undeliverable'|'trap'|'litigator'|'typo'
 *   |'role'|'dns_error'|'catch_all'|'mailbox_risky'|'mailbox_unknown'|'protected'
 *   |'free'} ReasonCode
 *
 * @typedef {object} Reason
 * @property {ReasonCode} code Stable, safe to match on.
 * @property {Verdict} verdict What this reason alone would make of the address.
 * @property {string} detail Plain English.
 *
 * @typedef {'deliverable'|'undeliverable'|'risky'|'unknown'|'not_checked'} Mailbox
 *
 * @typedef {object} AddressResult
 * @property {string} input As it appeared in the list.
 * @property {string} email Normalised.
 * @property {Verdict} verdict The worst verdict among its reasons; 'keep' with none.
 * @property {Reason[]} reasons
 * @property {string} [suggestion] The address it was probably meant to be.
 * @property {Mailbox} mailbox What the mailbox check said, or 'not_checked'.
 * @property {string | null} [provider] Mailbox provider, when Analyzemail detected one.
 *
 * @typedef {object} Summary
 * @property {number} total Addresses in the list, duplicates included.
 * @property {number} keep
 * @property {number} review
 * @property {number} remove
 * @property {number} duplicates
 * @property {number} removePercent Share of distinct addresses to remove, 0 to 100.
 *   Duplicates are left out: sending twice is wasteful, not dangerous.
 * @property {number} maxRemovePercent
 * @property {boolean} passed Whether removePercent is at or under the limit.
 * @property {'complete'|'partial'|'skipped'} mailboxCheck
 * @property {number} creditsUsed
 * @property {Partial<Record<ReasonCode, number>>} reasons Addresses per reason.
 *
 * @typedef {object} Report
 * @property {string} checkedAt ISO 8601.
 * @property {Summary} summary
 * @property {AddressResult[]} addresses In list order.
 * @property {string[]} notes Anything the reader needs to know to trust the result,
 *   such as checks that did not run.
 *
 * @typedef {object} CheckOptions
 * @property {boolean} [dns] Look up each domain's mail servers. Default true.
 * @property {DnsResolver} [resolver]
 * @property {AnalyzemailClient} [client] Enables mailbox checks. One credit per
 *   distinct address that survives the local checks.
 * @property {number} [maxCredits] Refuse to start mailbox checks that would spend
 *   more than this. Default 1000.
 * @property {number} [maxRemovePercent] Default 2.
 * @property {number} [concurrency] Mailbox checks in flight at once. Default 5.
 * @property {(done: number, total: number) => void} [onProgress] Mailbox checks.
 */

export const DEFAULT_MAX_REMOVE_PERCENT = 2
export const DEFAULT_MAX_CREDITS = 1000

const VERDICT_ORDER = { keep: 0, review: 1, remove: 2 }

/** Reasons that mean mail to the address bounces, as opposed to arriving somewhere bad. */
export const BOUNCE_REASONS = new Set([
  'syntax',
  'no_mail_domain',
  'null_mx',
  'parked',
  'mailbox_undeliverable',
])

export class GuardError extends Error {
  /**
   * @param {'credit_limit'|'insufficient_credits'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}

/**
 * Checks a list before it is sent to. Local checks always run and cost nothing;
 * mailbox checks run only when a client is given, only on addresses the local checks
 * did not already rule out, and never on a duplicate.
 *
 * @param {string[]} inputs
 * @param {CheckOptions} [options]
 * @returns {Promise<Report>}
 */
export async function checkList(inputs, options = {}) {
  const {
    dns = true,
    client,
    maxCredits = DEFAULT_MAX_CREDITS,
    maxRemovePercent = DEFAULT_MAX_REMOVE_PERCENT,
    concurrency = 5,
    onProgress,
  } = options
  const resolver = dns ? (options.resolver ?? createResolver()) : null

  /** @type {string[]} */
  const notes = []
  /** @type {Map<string, AddressResult>} */
  const firstSeen = new Map()
  /** @type {AddressResult[]} */
  const results = inputs.map((input) => {
    const email = normaliseAddress(input)
    /** @type {AddressResult} */
    const result = { input, email, verdict: 'keep', reasons: [], mailbox: 'not_checked' }
    const original = firstSeen.get(email)
    if (original && email) {
      add(result, 'duplicate', 'remove', `Already in the list as ${original.input}.`)
    } else {
      firstSeen.set(email, result)
      localChecks(result)
    }
    return result
  })
  const distinct = [...firstSeen.values()]

  if (resolver) {
    await domainChecks(distinct, resolver)
  } else {
    notes.push('DNS checks were turned off, so domains that cannot receive mail were not caught.')
  }

  results.forEach(settleVerdict)

  let mailboxCheck = /** @type {Summary['mailboxCheck']} */ ('skipped')
  let creditsUsed = 0
  const candidates = distinct.filter((r) => r.verdict !== 'remove')

  if (client && candidates.length > 0) {
    ;({ mailboxCheck, creditsUsed } = await mailboxChecks(candidates, client, {
      maxCredits,
      concurrency,
      notes,
      onProgress,
    }))
  } else if (!client && candidates.length > 0) {
    notes.push(
      `Mailboxes were not checked. ${candidates.length} address` +
        `${candidates.length === 1 ? '' : 'es'} passed the local checks, which catch ` +
        'addresses that can never work but cannot tell whether a mailbox exists. ' +
        `Set ANALYZEMAIL_API_KEY to check them (one credit each; key at ${API_KEY_URL}).`,
    )
  }

  results.forEach(settleVerdict)

  return {
    checkedAt: new Date().toISOString(),
    summary: summarise(results, { maxRemovePercent, mailboxCheck, creditsUsed }),
    addresses: results,
    notes,
  }
}

/**
 * @param {AddressResult} result
 */
function settleVerdict(result) {
  result.verdict = result.reasons.reduce(
    (worst, reason) =>
      VERDICT_ORDER[reason.verdict] > VERDICT_ORDER[worst] ? reason.verdict : worst,
    /** @type {Verdict} */ ('keep'),
  )
}

/**
 * @param {AddressResult} result
 * @param {ReasonCode} code
 * @param {Verdict} verdict
 * @param {string} detail
 */
function add(result, code, verdict, detail) {
  if (result.reasons.some((r) => r.code === code)) return
  result.reasons.push({ code, verdict, detail })
}

/**
 * @param {AddressResult} result
 */
function localChecks(result) {
  if (!isValidSyntax(result.email)) {
    add(result, 'syntax', 'remove', 'Not a valid email address, so it can never receive mail.')
    return
  }
  const { local, domain } = splitAddress(result.email)

  // Checked before disposable: the disposable list includes common typo domains, and
  // "you mistyped gmail" is the more useful thing to say about them.
  const suggestion = typoSuggestion(domain)
  if (suggestion) {
    result.suggestion = `${local}@${suggestion}`
    add(
      result,
      'typo',
      'remove',
      `${domain} looks like a typo of ${suggestion}. Mail to it will not reach the person, ` +
        'and typo domains are sometimes registered to collect misdirected mail.',
    )
  } else {
    const disposable = disposableMatch(domain)
    if (disposable) {
      add(
        result,
        'disposable',
        'remove',
        `${disposable} hands out throwaway inboxes. Nobody reads what arrives there later.`,
      )
    }
  }

  if (isRole(local)) {
    add(
      result,
      'role',
      'review',
      `${local}@ is a shared inbox, not a person. Fine for a reply, poor for marketing: ` +
        'nobody opted in, and complaints from shared inboxes are common.',
    )
  }

  if (isFree(domain)) {
    add(result, 'free', 'keep', 'A free consumer provider. Informational only.')
  }
}

/**
 * @param {AddressResult[]} results Distinct, in list order.
 * @param {DnsResolver} resolver
 */
async function domainChecks(results, resolver) {
  /** @type {Map<string, AddressResult[]>} */
  const byDomain = new Map()
  for (const r of results) {
    if (r.reasons.some((x) => x.code === 'syntax')) continue
    const domain = asciiDomain(splitAddress(r.email).domain)
    const list = byDomain.get(domain) ?? []
    list.push(r)
    byDomain.set(domain, list)
  }

  await mapLimit([...byDomain.keys()], 20, async (domain) => {
    const check = await checkDomain(domain, resolver)
    for (const r of byDomain.get(domain) ?? []) {
      if (check.mail === 'none') {
        add(r, 'no_mail_domain', 'remove', `${domain} does not exist or has no mail servers.`)
      } else if (check.mail === 'null_mx') {
        add(r, 'null_mx', 'remove', `${domain} publishes a null MX: it accepts no mail at all.`)
      } else if (check.mail === 'error') {
        add(
          r,
          'dns_error',
          'review',
          `DNS did not answer for ${domain}, so its mail servers could not be checked.`,
        )
      }
      if (check.parked) {
        add(
          r,
          'parked',
          'remove',
          `${domain} is parked on ${check.parked}: for sale, not in use, nobody receives mail.`,
        )
      }
    }
  })
}

/**
 * @param {AddressResult[]} candidates
 * @param {AnalyzemailClient} client
 * @param {{ maxCredits: number, concurrency: number, notes: string[], onProgress?: (done: number, total: number) => void }} options
 * @returns {Promise<{ mailboxCheck: Summary['mailboxCheck'], creditsUsed: number }>}
 */
async function mailboxChecks(candidates, client, options) {
  const { maxCredits, concurrency, notes, onProgress } = options
  const needed = candidates.length

  if (needed > maxCredits) {
    throw new GuardError(
      'credit_limit',
      `Checking mailboxes would use ${needed} credits, over the limit of ${maxCredits}. ` +
        'Raise it with --max-credits (or max_credits) if that is intended.',
    )
  }

  const balance = await client.credits()
  if (balance < needed) {
    throw new GuardError(
      'insufficient_credits',
      `Checking mailboxes needs ${needed} credits and the account has ${balance}. ` +
        `Buy credits at ${CREDITS_URL}, or run without an API key ` +
        'for the local checks only.',
    )
  }

  let done = 0
  let creditsUsed = 0
  let checked = 0
  /** @type {AnalyzemailError | null} */
  let stopped = null
  let failed = 0

  await mapLimit(candidates, concurrency, async (r) => {
    if (stopped) {
      onProgress?.(++done, needed)
      return
    }
    try {
      const verification = await client.verify(r.email)
      if (verification) {
        applyVerification(r, verification)
        checked++
        if (verification.status !== 'unknown') creditsUsed++
      }
    } catch (error) {
      if (!(error instanceof AnalyzemailError)) throw error
      // Account-level failures will fail every remaining call the same way.
      if (['unauthorized', 'insufficient_credits', 'rate_limited', 'forbidden'].includes(error.code)) {
        stopped ??= error
      } else {
        failed++
      }
    } finally {
      onProgress?.(++done, needed)
    }
  })

  // Assigned inside the workers, which TypeScript's narrowing cannot see.
  const stoppedBy = /** @type {AnalyzemailError | null} */ (stopped)
  if (stoppedBy) {
    notes.push(
      `Mailbox checks stopped after ${checked} of ${needed}: ${stoppedBy.message} ` +
        'The rest were only checked locally.',
    )
  }
  if (failed > 0) {
    notes.push(`${failed} mailbox check${failed === 1 ? '' : 's'} failed and were only checked locally.`)
  }
  const unfinished = needed - checked - failed
  if (!stoppedBy && unfinished > 0) {
    notes.push(
      `${unfinished} mailbox check${unfinished === 1 ? ' was' : 's were'} still running when ` +
        'send-guard stopped waiting. They were only checked locally.',
    )
  }

  return { mailboxCheck: checked === needed ? 'complete' : 'partial', creditsUsed }
}

/**
 * @param {AddressResult} r
 * @param {Verification} v
 */
function applyVerification(r, v) {
  r.mailbox = v.status
  r.provider = v.provider

  if (v.is_trap) {
    add(r, 'trap', 'remove', 'A known spam trap. Mailing it is how senders end up on blocklists.')
  }
  if (v.is_litigator) {
    add(r, 'litigator', 'remove', 'Belongs to a known serial litigant over unsolicited email.')
  }
  if (v.is_disposable && !r.suggestion) {
    add(r, 'disposable', 'remove', 'A throwaway inbox. Nobody reads what arrives there later.')
  }
  if (v.is_parked) {
    add(r, 'parked', 'remove', 'The domain is parked: for sale, not in use.')
  }
  if (v.is_catchall) {
    add(
      r,
      'catch_all',
      'review',
      'The domain accepts mail for every address, so this mailbox cannot be confirmed.',
    )
  }
  if (v.is_protected) {
    add(
      r,
      'protected',
      'review',
      'Behind a security gateway that hides whether mailboxes exist.',
    )
  }
  if (v.is_role) {
    add(r, 'role', 'review', 'A shared inbox, not a person.')
  }

  if (v.status === 'undeliverable') {
    const code = v.smtp_code ? ` (SMTP ${v.smtp_code})` : ''
    add(r, 'mailbox_undeliverable', 'remove', `The mail server says this mailbox does not exist${code}.`)
  } else if (v.status === 'unknown') {
    add(r, 'mailbox_unknown', 'review', 'The mail server gave no answer. No credit was charged.')
  } else if (v.status === 'risky' && !r.reasons.some((x) => x.verdict !== 'keep')) {
    add(r, 'mailbox_risky', 'review', `Analyzemail rated this risky${v.reason ? ` (${v.reason})` : ''}.`)
  }
}

/**
 * @param {AddressResult[]} results
 * @param {{ maxRemovePercent: number, mailboxCheck: Summary['mailboxCheck'], creditsUsed: number }} extra
 * @returns {Summary}
 */
function summarise(results, extra) {
  /** @type {Partial<Record<ReasonCode, number>>} */
  const reasons = {}
  let keep = 0
  let review = 0
  let remove = 0
  let duplicates = 0

  for (const r of results) {
    if (r.verdict === 'keep') keep++
    else if (r.verdict === 'review') review++
    else remove++
    for (const reason of r.reasons) reasons[reason.code] = (reasons[reason.code] ?? 0) + 1
    if (r.reasons.some((x) => x.code === 'duplicate')) duplicates++
  }

  const distinct = results.length - duplicates
  const removePercent =
    distinct === 0 ? 0 : Math.round(((remove - duplicates) / distinct) * 1000) / 10

  return {
    total: results.length,
    keep,
    review,
    remove,
    duplicates,
    removePercent,
    maxRemovePercent: extra.maxRemovePercent,
    passed: removePercent <= extra.maxRemovePercent,
    mailboxCheck: extra.mailboxCheck,
    creditsUsed: extra.creditsUsed,
    reasons,
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function mapLimit(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  })
  await Promise.all(workers)
}
