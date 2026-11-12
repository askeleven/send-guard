import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { starHint } from '../bin/star-hint.js'

const base = () => {
  const out = []
  return { out, deps: { env: {}, tty: true, stateDir: mkdtempSync(join(tmpdir(), 'star-')), write: (s) => out.push(s), now: 1e12 } }
}

test('prints once on a successful interactive run, then waits a week', () => {
  const { out, deps } = base()
  assert.equal(starHint('x', 0, ['a.txt'], deps), true)
  assert.match(out[0], /github\.com\/askeleven\/x/)
  assert.equal(starHint('x', 0, ['a.txt'], { ...deps, now: 1e12 + 1000 }), false)
  assert.equal(starHint('x', 0, ['a.txt'], { ...deps, now: 1e12 + 8 * 864e5 }), true)
})

test('stays quiet when it should', () => {
  const { out, deps } = base()
  assert.equal(starHint('x', 1, [], deps), false)
  assert.equal(starHint('x', 0, [], { ...deps, tty: false }), false)
  assert.equal(starHint('x', 0, [], { ...deps, env: { CI: 'true' } }), false)
  assert.equal(starHint('x', 0, [], { ...deps, env: { ASKELEVEN_NO_STAR: '1' } }), false)
  assert.equal(starHint('x', 0, [], { ...deps, env: { NO_UPDATE_NOTIFIER: '1' } }), false)
  assert.equal(starHint('x', 0, ['a', '--json'], deps), false)
  assert.equal(starHint('x', 0, ['--help'], deps), false)
  assert.equal(starHint('x', 0, ['mcp'], deps), false)
  assert.equal(out.length, 0)
})
