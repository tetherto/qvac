import { BARE_PACK_NODE_ENGINES, isBarePackNodeSupported } from '@qvac/sdk/commands'
import type { Check } from '@/doctor/check'

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

const NODE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+/

export const checkNodeVersion: Check = (ctx) => {
  const version = ctx.nodeVersion
  if (!NODE_VERSION_PATTERN.test(version)) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: version,
      hint: `Could not parse Node.js version; expected ${BARE_PACK_NODE_ENGINES}.`
    }
  }
  const display = version.startsWith('v') ? version : `v${version}`
  if (!isBarePackNodeSupported(version)) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'fail',
      severity: 'required',
      value: display,
      hint: `Upgrade Node.js to ${BARE_PACK_NODE_ENGINES} (current: ${display}); bare-pack's bare-module-lexer addon aborts on older Node.`
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
