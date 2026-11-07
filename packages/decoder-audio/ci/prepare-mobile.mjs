#!/usr/bin/env node
// decoder-audio's test:mobile, as main's decoder-audio mobile workflow prepared it: the advisory check that the
// generated mobile tests are current, then the speech ggml build check. It has no prebuilds or models to stage.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })

try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
sh('node', ['../../scripts/ci/check-speech-ggml-builds.mjs', '--package', '.'])
