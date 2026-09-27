import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkList,
  createFixtureResolver,
  createClient,
  parseInput,
  normaliseAddress,
  isValidSyntax,
  typoSuggestion,
  AnalyzemailError,
  GuardError,
} from '../src/index.js'
import { writeClean } from '../src/output.js'
import { formatText } from '../src/report.js'
import { serve } from '../src/mcp.js'
import { DISPOSABLE_DOMAINS } from '../src/data/disposable.js'
import { FREE_DOMAINS } from '../src/data/free.js'

const MX = [{ exchange: 'mx.example.net', priority: 10 }]

/** Every domain in these tests has mail servers unless a test says otherwise. */
const resolver = createFixtureResolver({
  mx: {
    'good.test': MX,
    'gmail.com': MX,
    'gmial.com': MX,
    'mailinator.com': MX,
    'nomx.test': [],
    'nullmx.test': [{ exchange: '', priority: 0 }],
    'flaky.test': null,
    'arecord.test': [],
    'parked.test': MX,
  },
  a: { 'arecord.test': ['192.0.2.1'] },
  ns: { 'parked.test': ['ns1.sedoparking.com', 'ns2.sedoparking.com'] },
})

/**
 * @param {import('../src/index.js').Report} report
 * @param {string} input
 */
const find = (report, input) => {
  const r = report.addresses.find((a) => a.input === input)
  assert.ok(r, `no result for ${input}`)
  return r
}

/** @param {import('../src/index.js').AddressResult} r */
const codes = (r) => r.reasons.map((x) => x.code)

/**
 * @param {Partial<import('../src/analyzemail.js').Verification>} over
 * @returns {import('../src/analyzemail.js').Verification}
 */
const verification = (over) => ({
  email: '',
  status: 'deliverable',
  reason: 'accepted',
  smtp_code: 250,
  mx: 'mx.example.net',
  provider: null,
  is_disposable: false,
  is_role: false,
  is_free: false,
  is_catchall: false,
  is_protected: false,
  is_trap: false,
  is_parked: false,
  is_litigator: false,
  checked_at: '2026-09-27T00:00:00Z',
  ...over,
})

/**
 * @param {Record<string, Partial<import('../src/analyzemail.js').Verification> | Error>} table
 * @param {number} [balance]
 */
function fakeClient(table, balance = 1_000_000) {
  /** @type {string[]} */
  const calls = []
  return {
    calls,
    credits: async () => balance,
    /** @param {string} email */
    verify: async (email) => {
      calls.push(email)
      const entry = table[email] ?? {}
      if (entry instanceof Error) throw entry
      return verification({ email, ...entry })
    },
  }
}

test('normaliseAddress cleans what exports contain', () => {
  assert.equal(normaliseAddress('  Jane@Example.COM '), 'jane@example.com')
  assert.equal(normaliseAddress('mailto:jane@example.com'), 'jane@example.com')
  assert.equal(normaliseAddress('Jane Doe <jane@example.com>'), 'jane@example.com')
  assert.equal(normaliseAddress('"jane@example.com"'), 'jane@example.com')
  assert.equal(normaliseAddress('jane@example.com.'), 'jane@example.com')
})

test('data: no real mailbox provider is on the disposable list', () => {
  assert.deepEqual([...DISPOSABLE_DOMAINS].filter((d) => FREE_DOMAINS.has(d)), [])
})

test('syntax: accepts real addresses, refuses broken ones', () => {
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.org', "o'neil@example.ie", 'x@bücher.de']) {
    assert.equal(isValidSyntax(ok), true, ok)
  }
  for (const bad of [
    'plainaddress',
    '@example.com',
    'jane@',
    'jane@@example.com',
    'jane..doe@example.com',
    '.jane@example.com',
    'jane@example',
    'jane@-example.com',
    'jane@example.c',
    `${'a'.repeat(65)}@example.com`,
  ]) {
    assert.equal(isValidSyntax(bad), false, bad)
  }
})

test('typoSuggestion: one edit from a major provider, never for the provider itself', () => {
  assert.equal(typoSuggestion('gmial.com'), 'gmail.com')
  assert.equal(typoSuggestion('gmail.con'), 'gmail.com')
  assert.equal(typoSuggestion('hotmial.com'), 'hotmail.com')
  assert.equal(typoSuggestion('yaho.com'), 'yahoo.com')
  assert.equal(typoSuggestion('gmail.com'), null)
  assert.equal(typoSuggestion('ymail.com'), null)
  assert.equal(typoSuggestion('acme.com'), null)
})

test('parseInput: plain list keeps malformed lines so they get reported', () => {
  const input = parseInput('email\njane@a.test\n\nnot an address\r\nbob@b.test\n')
  assert.equal(input.format, 'lines')
  assert.deepEqual(input.addresses, ['jane@a.test', 'not an address', 'bob@b.test'])
})

test('parseInput: CSV finds the email column by header', () => {
  const input = parseInput('Name,Email Address,Plan\n"Doe, Jane",jane@a.test,pro\nBob,,free\n')
  assert.equal(input.format, 'csv')
  assert.deepEqual(input.addresses, ['jane@a.test'])
  assert.equal(input.skipped, 1)
  assert.deepEqual(input.rows[0], ['Doe, Jane', 'jane@a.test', 'pro'])
})

test('parseInput: headerless and semicolon CSV finds the column holding addresses', () => {
  const input = parseInput('Jane;jane@a.test;1\nBob;bob@b.test;2\n')
  assert.equal(input.delimiter, ';')
  assert.equal(input.header, null)
  assert.deepEqual(input.addresses, ['jane@a.test', 'bob@b.test'])
})

test('parseInput: --column by name and number, with a clear error for a wrong name', () => {
  const csv = 'work,home\njane@work.test,jane@home.test\n'
  assert.deepEqual(parseInput(csv, { column: 'home' }).addresses, ['jane@home.test'])
  assert.deepEqual(parseInput(csv, { column: '2' }).addresses, ['jane@home.test'])
  assert.throws(() => parseInput(csv, { column: 'mobile' }), /Columns: work, home/)
})

test('local checks: each problem gets its own reason and verdict', async () => {
  const report = await checkList(
    [
      'jane@good.test',
      'JANE@good.test',
      'broken@',
      'x@mailinator.com',
      'a@nomx.test',
      'b@nullmx.test',
      'c@flaky.test',
      'd@arecord.test',
      'e@parked.test',
      'info@good.test',
      'bob@gmial.com',
      'sam@gmail.com',
    ],
    { resolver },
  )

  assert.deepEqual(find(report, 'jane@good.test').verdict, 'keep')
  assert.deepEqual(codes(find(report, 'JANE@good.test')), ['duplicate'])
  assert.deepEqual(codes(find(report, 'broken@')), ['syntax'])
  assert.deepEqual(codes(find(report, 'x@mailinator.com')), ['disposable'])
  assert.deepEqual(codes(find(report, 'a@nomx.test')), ['no_mail_domain'])
  assert.deepEqual(codes(find(report, 'b@nullmx.test')), ['null_mx'])
  assert.equal(find(report, 'e@parked.test').verdict, 'remove')
  assert.deepEqual(codes(find(report, 'e@parked.test')), ['parked'])

  // A resolver failure says nothing about the domain, so it must not remove anything.
  assert.deepEqual(codes(find(report, 'c@flaky.test')), ['dns_error'])
  assert.equal(find(report, 'c@flaky.test').verdict, 'review')

  // RFC 5321: no MX but an A record still receives mail.
  assert.equal(find(report, 'd@arecord.test').verdict, 'keep')

  assert.equal(find(report, 'info@good.test').verdict, 'review')
  // gmial.com is also on the disposable list; the typo is the useful explanation.
  const typo = find(report, 'bob@gmial.com')
  assert.equal(typo.suggestion, 'bob@gmail.com')
  assert.deepEqual(codes(typo), ['typo'])
  assert.equal(typo.verdict, 'remove')

  const free = find(report, 'sam@gmail.com')
  assert.deepEqual(codes(free), ['free'])
  assert.equal(free.verdict, 'keep')

  assert.equal(report.summary.duplicates, 1)
  assert.equal(report.summary.mailboxCheck, 'skipped')
  assert.match(report.notes.join(' '), /Mailboxes were not checked\. 5 addresses passed/)
})

test('gate: removal share leaves duplicates out and respects the limit', async () => {
  const list = [
    ...Array.from({ length: 49 }, (_, i) => `p${i}@good.test`),
    'broken@',
    'p0@good.test',
  ]
  const at2 = await checkList(list, { resolver })
  assert.equal(at2.summary.removePercent, 2)
  assert.equal(at2.summary.passed, true)

  const at1 = await checkList(list, { resolver, maxRemovePercent: 1 })
  assert.equal(at1.summary.passed, false)
})

test('mailbox checks: only distinct addresses that survived local checks are sent', async () => {
  const client = fakeClient({
    'gone@good.test': { status: 'undeliverable', reason: 'rejected', smtp_code: 550 },
    'any@good.test': { status: 'risky', reason: 'catch_all', is_catchall: true },
    'trap@good.test': { status: 'risky', reason: 'trap', is_trap: true },
    'quiet@good.test': { status: 'unknown', reason: 'timeout', smtp_code: null },
  })
  const report = await checkList(
    [
      'ok@good.test',
      'gone@good.test',
      'any@good.test',
      'trap@good.test',
      'quiet@good.test',
      'OK@good.test',
      'broken@',
      'a@nomx.test',
    ],
    { resolver, client },
  )

  assert.deepEqual(client.calls.sort(), [
    'any@good.test',
    'gone@good.test',
    'ok@good.test',
    'quiet@good.test',
    'trap@good.test',
  ])
  assert.equal(find(report, 'ok@good.test').mailbox, 'deliverable')
  assert.equal(find(report, 'ok@good.test').verdict, 'keep')
  assert.deepEqual(codes(find(report, 'gone@good.test')), ['mailbox_undeliverable'])
  assert.match(find(report, 'gone@good.test').reasons[0].detail, /SMTP 550/)
  assert.deepEqual(codes(find(report, 'any@good.test')), ['catch_all'])
  assert.equal(find(report, 'trap@good.test').verdict, 'remove')
  assert.equal(find(report, 'quiet@good.test').verdict, 'review')

  // The unknown result is refunded server-side, so it is not counted as spent.
  assert.equal(report.summary.creditsUsed, 4)
  assert.equal(report.summary.mailboxCheck, 'complete')
})

test('mailbox checks: refuse before spending over the credit limit or the balance', async () => {
  const list = ['a@good.test', 'b@good.test', 'c@good.test']

  const capped = fakeClient({})
  await assert.rejects(
    checkList(list, { resolver, client: capped, maxCredits: 2 }),
    (/** @type {GuardError} */ e) => e instanceof GuardError && e.code === 'credit_limit',
  )
  assert.equal(capped.calls.length, 0)

  const poor = fakeClient({}, 2)
  await assert.rejects(
    checkList(list, { resolver, client: poor }),
    (/** @type {GuardError} */ e) => e.code === 'insufficient_credits',
  )
  assert.equal(poor.calls.length, 0)
})

test('mailbox checks: an account-level error stops the run and says so', async () => {
  const client = fakeClient({
    'b@good.test': new AnalyzemailError('rate_limited', 'Daily limit reached.', { retryAfter: 3600 }),
  })
  const report = await checkList(['a@good.test', 'b@good.test', 'c@good.test', 'd@good.test'], {
    resolver,
    client,
    concurrency: 1,
  })
  assert.deepEqual(client.calls, ['a@good.test', 'b@good.test'])
  assert.equal(report.summary.mailboxCheck, 'partial')
  assert.match(report.notes.join(' '), /stopped after 1 of 4: Daily limit reached/)
  assert.equal(find(report, 'd@good.test').mailbox, 'not_checked')
})

test('client: sends the key, polls a pending check, retries a short 429', async () => {
  /** @type {{ url: string, init: RequestInit }[]} */
  const requests = []
  const responses = [
    new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), {
      status: 429,
      headers: { 'Retry-After': '1' },
    }),
    new Response(JSON.stringify({ data: { id: 'v1', state: 'pending', result: null } }), { status: 202 }),
    new Response(JSON.stringify({ data: { id: 'v1', state: 'pending', result: null } }), { status: 202 }),
    new Response(
      JSON.stringify({ data: { id: 'v1', state: 'complete', result: verification({ email: 'a@b.test' }) } }),
      { status: 200 },
    ),
  ]
  /** @type {number[]} */
  const slept = []
  const client = createClient({
    apiKey: 'am_live_test',
    baseUrl: 'https://api.invalid/v2/',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} })
      const next = responses.shift()
      assert.ok(next)
      return next
    },
    sleep: async (ms) => {
      slept.push(ms)
    },
  })

  const result = await client.verify('a@b.test')
  assert.equal(result?.status, 'deliverable')
  assert.equal(requests[0].url, 'https://api.invalid/v2/verify')
  assert.equal(/** @type {Record<string, string>} */ (requests[0].init.headers)['X-API-Key'], 'am_live_test')
  assert.equal(requests[2].url, 'https://api.invalid/v2/verify/v1')
  assert.equal(slept[0], 1000)
})

test('client: maps API errors and does not retry the daily limit', async () => {
  const client = createClient({
    apiKey: 'am_live_test',
    baseUrl: 'https://api.invalid/v2',
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'Buy credits.' } }), {
        status: 402,
      }),
    sleep: async () => {},
  })
  await assert.rejects(client.verify('a@b.test'), (/** @type {AnalyzemailError} */ e) => e.code === 'insufficient_credits')

  let calls = 0
  const limited = createClient({
    apiKey: 'am_live_test',
    baseUrl: 'https://api.invalid/v2',
    fetch: async () => {
      calls++
      return new Response('{}', { status: 429, headers: { 'Retry-After': '7200' } })
    },
    sleep: async () => {},
  })
  await assert.rejects(limited.verify('a@b.test'), (/** @type {AnalyzemailError} */ e) => e.code === 'rate_limited')
  assert.equal(calls, 1)
})

test('writeClean: CSV keeps header and other columns, drops removed rows', async () => {
  const input = parseInput('name,email\n"Doe, Jane",jane@good.test\nBad,broken@\nInfo,info@good.test\n')
  const report = await checkList(input.addresses, { resolver })
  assert.equal(writeClean(input, report), 'name,email\n"Doe, Jane",jane@good.test\n')
  assert.equal(
    writeClean(input, report, { includeReview: true }),
    'name,email\n"Doe, Jane",jane@good.test\nInfo,info@good.test\n',
  )
})

test('formatText: verdict first, grouped reasons, suggestion shown', async () => {
  const report = await checkList(['jane@good.test', 'broken@', 'bob@gmial.com'], { resolver })
  const text = formatText(report, { colour: false })
  assert.match(text, /^\nFAIL {2}66\.7% of the list should be removed/)
  assert.match(text, /Invalid address \(1\)\n {6}broken@/)
  assert.match(text, /did you mean bob@gmail\.com\?/)
})

/**
 * @param {object[]} messages
 * @param {Parameters<typeof serve>[0]} [options]
 * @returns {Promise<any[]>}
 */
async function mcpSession(messages, options = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  /** @type {string[]} */
  const chunks = []
  output.on('data', (c) => chunks.push(String(c)))
  const done = serve({ input, output, env: {}, checkOptions: { resolver }, ...options })
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`)
  input.end()
  await done
  return chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
}

test('mcp: initialize, list tools, and check addresses', async () => {
  const replies = await mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_emails', arguments: { emails: ['jane@good.test', 'broken@'] } } },
    { jsonrpc: '2.0', id: 4, method: 'nope' },
  ])
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))

  assert.equal(replies.length, 4, 'the notification gets no reply')
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.deepEqual(byId[2].result.tools.map((/** @type {{name: string}} */ t) => t.name), ['check_emails', 'check_file'])

  const payload = byId[3].result.structuredContent
  assert.equal(payload.passed, false)
  assert.deepEqual(payload.keep, ['jane@good.test'])
  assert.deepEqual(payload.remove, [
    { email: 'broken@', reasons: ['syntax'], detail: 'Not a valid email address, so it can never receive mail.' },
  ])
  assert.deepEqual(JSON.parse(byId[3].result.content[0].text), payload)
  assert.equal(byId[4].error.code, -32601)
})

test('mcp: check_file writes the clean list; tool failures come back as isError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'send-guard-'))
  const listPath = join(dir, 'list.csv')
  const outPath = join(dir, 'clean.csv')
  await writeFile(listPath, 'email,plan\njane@good.test,pro\nx@mailinator.com,free\n')

  const replies = await mcpSession(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_file', arguments: { path: listPath, out_path: outPath } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_emails', arguments: { emails: ['a@good.test', 'b@good.test'], max_credits: 1 } } },
    ],
    { env: { ANALYZEMAIL_API_KEY: 'am_live_test' }, checkOptions: { resolver, client: fakeClient({}) } },
  )
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))

  assert.equal(byId[1].result.structuredContent.out_path, outPath)
  assert.equal(await readFile(outPath, 'utf8'), 'email,plan\njane@good.test,pro\n')

  assert.equal(byId[2].result.isError, true)
  assert.match(byId[2].result.content[0].text, /would use 2 credits, over the limit of 1/)
})
