// Gate for `npm publish` (wired via `prepublishOnly` in package.json).
import { fileURLToPath } from 'node:url'
import { checkPublishReady } from '@qvac/cli-kit/build'

const errors = checkPublishReady({
  root: fileURLToPath(new URL('..', import.meta.url)),
  checks: [sdkReady]
})

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

// the SDK commands under qvac sdk need @qvac/sdk from npm, at a version with its ./commands
function sdkReady(pkg) {
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

  return errors
}

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
