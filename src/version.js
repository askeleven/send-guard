import { readFileSync } from 'node:fs'

/** The published version, read from package.json so there is one place to bump it. */
export const VERSION = /** @type {{ version: string }} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
).version
