#!/usr/bin/env node
// Gate for `npm publish` (wired via `prepublishOnly` in package.json).
//
// Published CLI installs need the generated npm shrinkwrap: npm ignores an
// installed dependency's overrides. Keep its direct specs aligned with the
// manifest; npm version handles release-version metadata separately.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PKG_PATH = path.resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))

const errors = []

const lockPath = path.resolve(__dirname, '..', 'npm-shrinkwrap.json')
if (!fs.existsSync(lockPath)) {
  errors.push('npm-shrinkwrap.json is missing; regenerate the npm distribution lock')
} else {
  const packages = JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages || {}
  const locked = packages['']
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const wanted = pkg[field] || {}
    const actual = locked?.[field] || {}
    for (const name of new Set([...Object.keys(wanted), ...Object.keys(actual)])) {
      if (wanted[name] !== actual[name]) {
        errors.push(`npm-shrinkwrap.json ${field}["${name}"] differs from package.json`)
      }
    }
  }
  // npm does not record overrides in the lock, so check their effect: every
  // locked copy of an overridden package must be the version the override names.
  for (const [name, spec] of Object.entries(pkg.overrides || {})) {
    if (typeof spec !== 'string') continue
    const version = spec.startsWith('$') ? pkg.dependencies?.[spec.slice(1)] : spec
    for (const [location, entry] of Object.entries(packages)) {
      if (location.endsWith('node_modules/' + name) && entry.version !== version) {
        errors.push(
          `npm-shrinkwrap.json ${location} is ${entry.version}; overrides want ${version}`
        )
      }
    }
  }
}

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
  'Cannot publish @qvac/cli — dependency metadata is not ready.',
  '',
  ...errors.map((e) => `  • ${e}`),
  '',
  'Regenerate npm-shrinkwrap.json and rebuild before publishing.',
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
