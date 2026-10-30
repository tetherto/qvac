#!/usr/bin/env node
// The shared runtime libraries resolve to one version in the SDK's tree. A release push checks the published
// @qvac/inference the release installs, as main's release check did; anything else replaces it with the in-repo engine,
// which can be ahead of npm, as main's PR check did.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const release =
  process.env.GITHUB_EVENT_NAME === 'push' &&
  (process.env.GITHUB_REF_NAME ?? '').startsWith('release-')
execFileSync(
  'node',
  [
    '.github/scripts/check-shared-runtime-libs.mjs',
    'packages/sdk',
    ...(release ? [] : ['--local', 'packages/inference'])
  ],
  { cwd: root, stdio: 'inherit' }
)
