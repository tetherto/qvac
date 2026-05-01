import type { Check } from '../check.js'

const MIN_NODE_MAJOR = 18
const RECOMMENDED_NODE_MAJOR = 20

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

function parseNodeMajor (version: string): number | null {
  const match = /^v?(\d+)\./.exec(version)
  if (!match || match[1] === undefined) return null
  const n = Number.parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

export const checkNodeVersion: Check = (ctx) => {
  const version = ctx.nodeVersion
  const major = parseNodeMajor(version)
  if (major === null) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: version,
      hint: `Could not parse Node.js version; expected v${MIN_NODE_MAJOR} or newer.`
    }
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'fail',
      severity: 'required',
      value: `v${version}`,
      hint: `Upgrade Node.js to v${MIN_NODE_MAJOR} or newer (current: v${version}).`
    }
  }
  if (major < RECOMMENDED_NODE_MAJOR) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: `v${version}`,
      hint: `Node.js v${MIN_NODE_MAJOR} is supported but end-of-life; upgrade to v${RECOMMENDED_NODE_MAJOR}+ when possible.`
    }
  }
  return {
    id: 'node-version',
    label: 'Node.js version',
    status: 'pass',
    severity: 'required',
    value: `v${version}`
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
