import { Resolver } from 'node:dns/promises'

/**
 * Every lookup resolves to the records, an empty array when the name has none, or null
 * when the lookup itself failed. The difference matters here in a way it does not for a
 * single-domain check: "this domain has no mail servers" removes every address at it,
 * "the resolver timed out" must not.
 *
 * @typedef {object} DnsResolver
 * @property {(name: string) => Promise<{exchange: string, priority: number}[] | null>} mx
 * @property {(name: string) => Promise<string[] | null>} ns
 * @property {(name: string) => Promise<string[] | null>} a IPv4 and IPv6 addresses.
 */

/** Queries that take longer than this count as failed, not as empty. */
const DEFAULT_TIMEOUT_MS = 5000

// NXDOMAIN and NODATA are answers. Everything else (timeouts, SERVFAIL, refused) is a
// failure to get one.
const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA'])

/**
 * @param {{ servers?: string[], timeoutMs?: number }} [options]
 * @returns {DnsResolver}
 */
export function createResolver(options = {}) {
  const { servers, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 })
  if (servers?.length) resolver.setServers(servers)

  /**
   * @template T
   * @param {() => Promise<T[]>} query
   * @returns {Promise<T[] | null>}
   */
  const run = async (query) => {
    try {
      return await query()
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code
      return code && EMPTY_CODES.has(code) ? [] : null
    }
  }

  return {
    mx: (name) => run(() => resolver.resolveMx(name)),
    ns: (name) => run(() => resolver.resolveNs(name)),
    a: async (name) => {
      const [v4, v6] = await Promise.all([
        run(() => resolver.resolve4(name)),
        run(() => resolver.resolve6(name)),
      ])
      if (v4 === null && v6 === null) return null
      return [...(v4 ?? []), ...(v6 ?? [])]
    },
  }
}

/**
 * Builds a resolver backed by a fixed map, for tests and for running without network.
 * A name mapped to null simulates a failed lookup.
 *
 * @param {{ mx?: Record<string, {exchange: string, priority: number}[] | null>, ns?: Record<string, string[] | null>, a?: Record<string, string[] | null> }} fixture
 * @returns {DnsResolver}
 */
export function createFixtureResolver(fixture) {
  /**
   * @template T
   * @param {Record<string, T[] | null> | undefined} table
   * @param {string} name
   * @returns {T[] | null}
   */
  const lookup = (table, name) => (table && name in table ? table[name] : [])
  return {
    mx: async (name) => lookup(fixture.mx, name),
    ns: async (name) => lookup(fixture.ns, name),
    a: async (name) => lookup(fixture.a, name),
  }
}
