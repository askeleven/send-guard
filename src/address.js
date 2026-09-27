import { domainToASCII } from 'node:url'
import { DISPOSABLE_DOMAINS } from './data/disposable.js'
import { ROLE_LOCAL_PARTS } from './data/roles.js'
import { FREE_DOMAINS } from './data/free.js'

// The same RFC-lite rule Analyzemail applies server-side: a dot-atom local part and a
// hostname domain with an alphabetic TLD. Quoted local parts and IP-literal domains are
// valid in RFC 5321 and refused here, because no list worth sending to contains them and
// a good share of mail servers refuse them too.
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LOCAL_RE = new RegExp(`^${ATOM}(\\.${ATOM})*$`, 'i')
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`, 'i')

/**
 * Cleans up what people and exports actually contain: surrounding whitespace, a
 * mailto: prefix, angle brackets, a trailing dot on the domain. Lowercases the whole
 * address. The local part is case-sensitive in theory and in no mailbox provider
 * anyone sends to, and lowercasing is what makes duplicate detection useful.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseAddress(raw) {
  let value = String(raw ?? '').trim()
  value = value.replace(/^mailto:/i, '')
  const angled = value.match(/<([^<>]*)>\s*$/)
  if (angled) value = angled[1].trim()
  value = value.replace(/^["']|["']$/g, '').trim()
  value = value.replace(/\.$/, '')
  return value.toLowerCase()
}

/**
 * @param {string} address A normalised address.
 * @returns {{ local: string, domain: string }} domain is '' when there is no '@'.
 */
export function splitAddress(address) {
  const at = address.lastIndexOf('@')
  if (at === -1) return { local: address, domain: '' }
  return { local: address.slice(0, at), domain: address.slice(at + 1) }
}

/**
 * Converts an internationalised domain to its ASCII form so it can be validated and
 * looked up. Returns '' when the domain cannot be converted.
 *
 * @param {string} domain
 * @returns {string}
 */
export function asciiDomain(domain) {
  if (/^[\x00-\x7f]*$/.test(domain)) return domain
  return domainToASCII(domain)
}

/**
 * @param {string} address A normalised address.
 * @returns {boolean}
 */
export function isValidSyntax(address) {
  const { local, domain } = splitAddress(address)
  if (!local || !domain) return false
  const ascii = asciiDomain(domain)
  if (!ascii) return false
  if (local.length > 64 || ascii.length > 253 || local.length + 1 + ascii.length > 254) {
    return false
  }
  return LOCAL_RE.test(local) && DOMAIN_RE.test(ascii)
}

/**
 * Matches the domain or any parent domain, so mail.example.test matches example.test.
 *
 * @param {string} domain
 * @param {Set<string>} set
 * @returns {string | null}
 */
function domainIn(domain, set) {
  const parts = domain.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.')
    if (set.has(candidate)) return candidate
  }
  return null
}

/**
 * @param {string} domain
 * @returns {string | null} The listed domain that matched.
 */
export function disposableMatch(domain) {
  return domainIn(domain, DISPOSABLE_DOMAINS)
}

/**
 * @param {string} local
 * @returns {boolean}
 */
export function isRole(local) {
  return ROLE_LOCAL_PARTS.has(local)
}

/**
 * @param {string} domain
 * @returns {boolean}
 */
export function isFree(domain) {
  return FREE_DOMAINS.has(domain)
}

// The providers that account for most consumer mail, and so for most typos. A typo of
// a small domain is indistinguishable from a different small domain.
const TYPO_TARGETS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'comcast.net',
  'proton.me',
  'protonmail.com',
  'yahoo.co.uk',
  'hotmail.co.uk',
  'btinternet.com',
  'gmx.com',
  'gmx.de',
  'web.de',
]

/**
 * Suggests the provider a domain was probably meant to be: one edit (insert, delete,
 * substitute, or swap two adjacent characters) away from a major consumer provider.
 * Never suggests anything for a domain that is itself a known provider.
 *
 * @param {string} domain
 * @returns {string | null}
 */
export function typoSuggestion(domain) {
  if (FREE_DOMAINS.has(domain) || TYPO_TARGETS.includes(domain)) return null
  for (const target of TYPO_TARGETS) {
    if (Math.abs(target.length - domain.length) <= 1 && editDistanceAtMostOne(domain, target)) {
      return target
    }
  }
  return null
}

/**
 * Optimal string alignment distance, bounded at one.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function editDistanceAtMostOne(a, b) {
  if (a === b) return true
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  if (a.length === b.length + 1) return a.slice(i + 1) === b.slice(i)
  if (b.length === a.length + 1) return b.slice(i + 1) === a.slice(i)
  return false
}
