#!/usr/bin/env node
// Bundles the Bergamot and IndicTrans model URLs into the mobile test assets, then emits the host pre-stage commands.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { emitPrestage } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sh = (cmd, args, env = process.env) =>
  execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit', env })

// Advisory, as main ran it.
try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
// The language pair main's dispatch defaulted to.
sh('bash', ['scripts/provision-mobile-models.sh'], {
  ...process.env,
  BERGAMOT_LANG_PAIR: process.env.BERGAMOT_LANG_PAIR || 'enit'
})
emitPrestage(PKG)
