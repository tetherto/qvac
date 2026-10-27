import { createRequire } from 'node:module'
import { Version, Range } from 'bare-semver'
import type { Check } from '@/lib/doctor/check'

const require = createRequire(import.meta.url)
// The CLI's own engines.node; bundling (bare-pack) is what needs this range.
const { engines } = require('../../../../package.json') as { engines: { node: string } }
const NODE_ENGINES = engines.node
const NODE_RANGE = Range.parse(NODE_ENGINES)

function parseNodeVersion(input: string): Version | null {
  if (input.length > 256) return null
  try {
    const version = Version.parse(input.trim().replace(/^v/, ''))
    return [version.major, version.minor, version.patch].every(Number.isSafeInteger)
      ? version
      : null
  } catch {
    return null
  }
}

// Where the `qvac` CLI itself can run. This is NOT the set of SDK deploy
// targets — the SDK additionally targets Android and iOS via Expo/BareKit,
// which are reported in the "Deploy targets" section.
const SUPPORTED_CLI_HOSTS: ReadonlyArray<string> = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
]

export const checkNodeVersion: Check = (ctx) => {
  const version = ctx.nodeVersion
  const parsed = parseNodeVersion(version)
  if (parsed === null) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: version,
      hint: `Could not parse Node.js version; expected ${NODE_ENGINES}.`
    }
  }
  const display = version.startsWith('v') ? version : `v${version}`
  // Compare the range directly to include prereleases, as the previous doctor
  // check did. Range.test intentionally excludes unmentioned prereleases.
  if (!NODE_RANGE.comparators.some((set) => set.every((comparator) => comparator.test(parsed)))) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'fail',
      severity: 'required',
      value: display,
      hint: `Upgrade Node.js to ${NODE_ENGINES} (current: ${display}); bundling needs Node 22.21+ on the 22 line or 24.9+.`
    }
  }
  return {
    id: 'node-version',
    label: 'Node.js version',
    status: 'pass',
    severity: 'required',
    value: display
  }
}

export const checkCliHost: Check = (ctx) => {
  const host = `${ctx.platform}-${ctx.arch}`
  if (SUPPORTED_CLI_HOSTS.includes(host)) {
    return {
      id: 'cli-host',
      label: 'CLI host',
      status: 'pass',
      severity: 'required',
      value: host
    }
  }
  return {
    id: 'cli-host',
    label: 'CLI host',
    status: 'fail',
    severity: 'required',
    value: host,
    hint: `The 'qvac' CLI cannot run on "${host}". Supported CLI hosts: ${SUPPORTED_CLI_HOSTS.join(', ')}. (Android/iOS are supported as SDK deploy targets, not as CLI hosts.)`
  }
}
