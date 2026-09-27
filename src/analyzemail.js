import { VERSION } from './version.js'

/** Production API. Override with ANALYZEMAIL_API_URL, for example to point at staging. */
export const DEFAULT_API_URL = 'https://analyzemail.com/api/v2'

/** Where a person gets a key. Shown in messages, never requested. */
export const API_KEY_URL = 'https://analyzemail.com/account/settings/api'

/** Where a person buys credits. */
export const CREDITS_URL = 'https://analyzemail.com/account/credits'

/**
 * The per-address result Analyzemail returns. Mirrors VerificationResult in the
 * published OpenAPI spec.
 *
 * @typedef {object} Verification
 * @property {string} email
 * @property {'deliverable'|'undeliverable'|'risky'|'unknown'} status
 * @property {string | null} reason
 * @property {number | null} smtp_code
 * @property {string | null} mx
 * @property {string | null} provider
 * @property {boolean} is_disposable
 * @property {boolean} is_role
 * @property {boolean} is_free
 * @property {boolean} is_catchall
 * @property {boolean} is_protected
 * @property {boolean} is_trap
 * @property {boolean} is_parked
 * @property {boolean} is_litigator
 * @property {string | null} checked_at
 *
 * @typedef {object} AnalyzemailClient
 * @property {() => Promise<number>} credits Credit balance.
 * @property {(email: string) => Promise<Verification | null>} verify One credit.
 *   Resolves null when the check was still running after the poll timeout; the
 *   credit for an unfinished check is refunded server-side if it ends as unknown.
 */

export class AnalyzemailError extends Error {
  /**
   * @param {string} code The API's machine-readable error code, or 'network_error'.
   * @param {string} message
   * @param {{ status?: number, retryAfter?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'AnalyzemailError'
    this.code = code
    this.status = extra.status
    this.retryAfter = extra.retryAfter
  }
}

/** A 429 that asks for longer than this is the daily limit, not a burst; stop instead. */
const MAX_RATE_LIMIT_WAIT_S = 60
const MAX_RETRIES = 3

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.pollTimeoutMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {AnalyzemailClient}
 */
export function createClient(options) {
  const {
    apiKey,
    baseUrl = process.env.ANALYZEMAIL_API_URL || DEFAULT_API_URL,
    fetch: fetchImpl = globalThis.fetch,
    pollIntervalMs = 3000,
    pollTimeoutMs = 120_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options

  if (!apiKey) throw new AnalyzemailError('unauthorized', 'No Analyzemail API key given.')
  const root = baseUrl.replace(/\/+$/, '')

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<{ status: number, json: any }>}
   */
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      /** @type {Response} */
      let response
      try {
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers: {
            'X-API-Key': apiKey,
            Accept: 'application/json',
            'User-Agent': `send-guard/${VERSION}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await sleep(2000 * 2 ** attempt)
          continue
        }
        throw new AnalyzemailError(
          'network_error',
          `Could not reach Analyzemail: ${/** @type {Error} */ (error).message}`,
        )
      }

      const json = /** @type {any} */ (await response.json().catch(() => null))

      if (response.ok) return { status: response.status, json }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 1
        if (retryAfter <= MAX_RATE_LIMIT_WAIT_S && attempt < MAX_RETRIES) {
          await sleep(retryAfter * 1000)
          continue
        }
        throw new AnalyzemailError(
          'rate_limited',
          json?.error?.message ?? 'Analyzemail rate limit reached.',
          { status: 429, retryAfter },
        )
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(2000 * 2 ** attempt)
        continue
      }

      throw new AnalyzemailError(
        json?.error?.code ?? 'http_error',
        json?.error?.message ?? `Analyzemail returned HTTP ${response.status}.`,
        { status: response.status },
      )
    }
  }

  return {
    async credits() {
      const { json } = await request('GET', '/credits')
      return Number(json?.data?.balance ?? 0)
    },

    async verify(email) {
      const first = await request('POST', '/verify', { email })
      if (first.json?.data?.state === 'complete') return first.json.data.result

      const id = first.json?.data?.id
      if (!id) throw new AnalyzemailError('http_error', 'Analyzemail returned no verification id.')

      const deadline = Date.now() + pollTimeoutMs
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs)
        const { json } = await request('GET', `/verify/${encodeURIComponent(id)}`)
        if (json?.data?.state === 'complete') return json.data.result
      }
      return null
    },
  }
}
