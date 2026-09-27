import { PARKED_NAMESERVERS } from './data/parked.js'

/**
 * @typedef {import('./resolver.js').DnsResolver} DnsResolver
 *
 * @typedef {object} DomainCheck
 * @property {'ok'|'none'|'null_mx'|'error'} mail Whether the domain can receive mail.
 *   'error' means DNS did not answer, which says nothing about the domain.
 * @property {string[]} mx Mail exchangers, best first. Empty when the domain relies
 *   on its A record.
 * @property {string | null} parked The parking nameserver matched, if any.
 */

/**
 * @param {string} domain ASCII form.
 * @param {DnsResolver} resolver
 * @returns {Promise<DomainCheck>}
 */
export async function checkDomain(domain, resolver) {
  const [mx, ns] = await Promise.all([resolver.mx(domain), resolver.ns(domain)])
  const nameservers = (ns ?? []).map((n) => n.toLowerCase())
  const parked =
    [...PARKED_NAMESERVERS].find((p) => nameservers.some((n) => n.includes(p))) ?? null

  if (mx === null) return { mail: 'error', mx: [], parked }

  // RFC 7505: a single "." exchange declares that the domain accepts no mail.
  if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) {
    return { mail: 'null_mx', mx: [], parked }
  }

  if (mx.length > 0) {
    const hosts = [...mx].sort((x, y) => x.priority - y.priority).map((r) => r.exchange)
    return { mail: 'ok', mx: hosts, parked }
  }

  // RFC 5321 section 5.1: with no MX, mail goes to the domain's own address.
  const a = await resolver.a(domain)
  if (a === null) return { mail: 'error', mx: [], parked }
  return { mail: a.length > 0 ? 'ok' : 'none', mx: [], parked }
}
