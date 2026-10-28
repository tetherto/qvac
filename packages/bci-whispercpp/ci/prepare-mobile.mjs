#!/usr/bin/env node
// bci's test:mobile, as main's bci mobile workflow prepared it: the advisory staleness check, then the
// mobile test assets (the manifest's models plus the fixtures from the private release, through GITHUB_TOKEN), then
// the speech ggml build check.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })

try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
sh('npm', ['run', 'test:mobile:generate'])
sh('node', ['../../scripts/ci/check-speech-ggml-builds.mjs', '--package', '.'])
