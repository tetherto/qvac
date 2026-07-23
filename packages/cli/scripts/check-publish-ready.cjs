#!/usr/bin/env node
// Gate for `npm publish` (wired via `prepublishOnly` in package.json).
//
// The CLI is built in-monorepo against a local @qvac/sdk: the direct
// dependency `@qvac/sdk` is set to `file:../sdk`, and `scripts.preinstall`
// builds that sibling so the symlink resolves a populated dist/. Both knobs
// MUST be flipped before publishing — otherwise the published artifact would
// (a) point consumers at a non-existent local path and (b) try to build a
// non-existent sibling on their machines. The dep range must also allow the
// SDK version that actually has the ./commands subpath on npm (0.12.0+).

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PKG_PATH = path.resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))

const errors = []

const sdkDep = pkg.dependencies && pkg.dependencies['@qvac/sdk']
if (typeof sdkDep !== 'string') {
  errors.push('dependencies["@qvac/sdk"] is missing')
} else if (/^(file:|link:)/.test(sdkDep)) {
  errors.push(`dependencies["@qvac/sdk"] still points at a local path ("${sdkDep}")`)
} else if (!rangeAllowsCommandsSubpath(sdkDep)) {
  errors.push(
    `dependencies["@qvac/sdk"] is "${sdkDep}" — must allow ` +
      '@qvac/sdk@0.12.0 or later (the first release with the ./commands subpath)'
  )
}

const preinstall = pkg.scripts && pkg.scripts.preinstall
if (typeof preinstall === 'string' && preinstall.includes('preinstall-build-local-sdk')) {
  errors.push(`scripts.preinstall still wires the monorepo helper ("${preinstall}")`)
}

if (errors.length === 0) {
  process.exit(0)
}

const message = [
  '',
  'Cannot publish @qvac/cli — the local-SDK fallback is still wired up.',
  '',
  ...errors.map((e) => `  • ${e}`),
  '',
  'Before publishing:',
  '  1. Confirm @qvac/sdk@0.12.0 (or later, with the ./commands subpath) is published to npm:',
  '       npm view @qvac/sdk@0.12.0 exports[\\".\\/commands\\"]',
  '  2. Set dependencies["@qvac/sdk"] to ^0.12.0 (or wider) in packages/cli/package.json.',
  '  3. Remove scripts.preinstall from packages/cli/package.json',
  '     (scripts/preinstall-build-local-sdk.cjs can stay on disk).',
  '  4. Re-run npm publish.',
  ''
].join('\n')

console.error(message)
process.exit(1)

// Minimal range check — avoids pulling in `semver` as a runtime dep just for
// publish-time validation. Accepts caret/tilde/range/comparator forms that
// can include 0.12.0 or higher, and rejects anything pinned to 0.11.x.
function rangeAllowsCommandsSubpath(range) {
  const trimmed = range.trim()

  // Wildcards / "any version" — trust the publisher.
  if (trimmed === '*' || trimmed === 'x' || trimmed === '' || trimmed === 'latest') {
    return true
  }

  // Caret/tilde forms: ^X.Y[.Z], ~X.Y[.Z]
  const caretTilde = trimmed.match(/^[\^~](\d+)\.(\d+)(?:\.(\d+))?/)
  if (caretTilde) {
    const major = Number(caretTilde[1])
    const minor = Number(caretTilde[2])
    if (major > 0) return true
    if (major === 0 && minor >= 12) return true
    return false
  }

  // Bare X.Y.Z or X.Y — accept anything strictly >= 0.12.0.
  const bare = trimmed.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
  if (bare) {
    const major = Number(bare[1])
    const minor = Number(bare[2])
    if (major > 0) return true
    if (major === 0 && minor >= 12) return true
    return false
  }

  // >=X.Y.Z forms — accept anything where the lower bound is >= 0.12.0.
  const gte = trimmed.match(/^>=?\s*(\d+)\.(\d+)/)
  if (gte) {
    const major = Number(gte[1])
    const minor = Number(gte[2])
    if (major > 0) return true
    if (major === 0 && minor >= 12) return true
    return false
  }

  // Unknown form — let the publisher decide.
  return true
}
