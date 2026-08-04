const MACOS_RUNTIME_EXECUTABLE_FILES = [
  '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
  '/usr/lib/libSystem.B.dylib',
  '/usr/lib/libc++.1.dylib',
  '/usr/lib/libresolv.9.dylib'
] as const

const MACOS_RUNTIME_READ_FILES = [
  '/dev/null',
  '/dev/random',
  '/dev/urandom',
  '/dev/zero'
] as const

const MACOS_RUNTIME_METADATA_FILES = ['/var'] as const

const MACOS_RUNTIME_SYSCTLS = [
  'hw.activecpu',
  'hw.memsize',
  'hw.ncpu',
  'hw.optional.arm.FEAT_CSSC',
  'hw.pagesize_compat',
  'kern.bootargs',
  'kern.hostname',
  'kern.iossupportversion',
  'kern.osproductversion',
  'kern.osrelease',
  'kern.osvariant_status',
  'security.mac.lockdown_mode_state'
] as const

export interface MacOsSandboxPolicyInput {
  readonly bareExecutable: string
  readonly childEntry: string
  readonly codeRoots: readonly string[]
  readonly resourceRoots: readonly string[]
  readonly executablePaths: readonly string[]
  readonly readOnlyRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly scratchRoot: string
  readonly loopbackPorts: readonly number[]
  readonly unixSocketPaths?: readonly string[]
}

export interface MacOsSandboxPolicy {
  readonly bareExecutable: string
  readonly childEntry: string
  readonly codeRoots: readonly string[]
  readonly resourceRoots: readonly string[]
  readonly executablePaths: readonly string[]
  readonly readOnlyRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly scratchRoot: string
  readonly loopbackPorts: readonly number[]
  readonly unixSocketPaths: readonly string[]
}

export function createMacOsSandboxPolicy(
  input: MacOsSandboxPolicyInput
): MacOsSandboxPolicy {
  const policy = {
    bareExecutable: validateAbsolutePath(input.bareExecutable, 'Bare executable'),
    childEntry: validateAbsolutePath(input.childEntry, 'child entry'),
    codeRoots: normalizePaths(input.codeRoots, 'code root'),
    resourceRoots: normalizePaths(input.resourceRoots, 'resource root'),
    executablePaths: normalizePaths(input.executablePaths, 'executable path'),
    readOnlyRoots: normalizePaths(input.readOnlyRoots, 'read-only root'),
    writeRoots: normalizePaths(input.writeRoots, 'write root'),
    scratchRoot: validateAbsolutePath(input.scratchRoot, 'scratch root'),
    loopbackPorts: normalizePorts(input.loopbackPorts),
    unixSocketPaths: normalizePaths(
      input.unixSocketPaths ?? [],
      'unix socket path'
    )
  }
  Object.freeze(policy.codeRoots)
  Object.freeze(policy.resourceRoots)
  Object.freeze(policy.executablePaths)
  Object.freeze(policy.readOnlyRoots)
  Object.freeze(policy.writeRoots)
  Object.freeze(policy.loopbackPorts)
  Object.freeze(policy.unixSocketPaths)
  return Object.freeze(policy)
}

export function renderSeatbeltProfile(policy: MacOsSandboxPolicy) {
  const readableFiles = sortedUnique([
    ...MACOS_RUNTIME_READ_FILES,
    ...MACOS_RUNTIME_EXECUTABLE_FILES,
    policy.bareExecutable,
    policy.childEntry,
    ...policy.executablePaths,
    ...policy.unixSocketPaths
  ])
  const readableRoots = sortedUnique([
    ...policy.codeRoots,
    ...policy.resourceRoots,
    ...policy.readOnlyRoots,
    ...policy.writeRoots,
    policy.scratchRoot
  ])
  const readableLocations = sortedUnique([
    ...readableFiles,
    ...readableRoots
  ])
  const executablePaths = sortedUnique([
    policy.bareExecutable,
    ...policy.executablePaths
  ])
  const executableMapRoots = sortedUnique([
    ...policy.codeRoots
  ])
  const executableMapFiles = sortedUnique([
    ...MACOS_RUNTIME_EXECUTABLE_FILES,
    ...executablePaths
  ])
  const writeRoots = sortedUnique([...policy.writeRoots, policy.scratchRoot])

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow signal (target self) (target children))',
    renderSysctlRule(MACOS_RUNTIME_SYSCTLS),
    renderFilteredRule(
      'file-read-metadata',
      sortedUnique([
        ...readableLocations,
        ...MACOS_RUNTIME_METADATA_FILES
      ]),
      readableRoots,
      true
    ),
    renderFilteredRule('file-read*', readableLocations, readableRoots),
    renderFilteredRule(
      'file-map-executable',
      executableMapFiles,
      executableMapRoots
    ),
    renderLiteralRule('process-exec', executablePaths),
    '(allow file-read-data (literal "/"))',
    '(allow file-read-data file-write-data (subpath "/dev/fd"))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))',
    renderFilteredRule('file-write*', [], writeRoots),
    ...renderNetworkRules(policy.loopbackPorts),
    ...renderUnixSocketRules(policy.unixSocketPaths),
    ''
  ].join('\n')
}

function renderNetworkRules(ports: readonly number[]) {
  if (ports.length === 0) return []
  return [
    '(allow network-outbound',
    ...ports.map((port) => `  (remote ip "localhost:${port}")`),
    ')'
  ]
}

function renderUnixSocketRules(sockets: readonly string[]) {
  if (sockets.length === 0) return []
  return [
    '(allow network-outbound',
    ...sockets.map(
      (socket) =>
        `  (remote unix-socket (path "${escapeSeatbeltLiteral(socket)}"))`
    ),
    ')'
  ]
}

function renderFilteredRule(
  operation: string,
  files: readonly string[],
  roots: readonly string[],
  includeAncestors = false
) {
  const filters = [
    ...files.map((file) => `  (literal "${escapeSeatbeltLiteral(file)}")`),
    ...roots.map((root) => `  (subpath "${escapeSeatbeltLiteral(root)}")`),
    ...(includeAncestors
      ? sortedUnique([...files, ...roots]).map(
          (value) =>
            `  (path-ancestors "${escapeSeatbeltLiteral(value)}")`
        )
      : [])
  ]
  return [`(allow ${operation}`, ...filters, ')'].join('\n')
}

function renderLiteralRule(operation: string, paths: readonly string[]) {
  return [
    `(allow ${operation}`,
    ...paths.map((value) => `  (literal "${escapeSeatbeltLiteral(value)}")`),
    ')'
  ].join('\n')
}

function renderSysctlRule(names: readonly string[]) {
  return [
    '(allow sysctl-read',
    `  (sysctl-name ${names
      .map((name) => `"${escapeSeatbeltLiteral(name)}"`)
      .join(' ')})`,
    ')'
  ].join('\n')
}

function normalizePaths(paths: readonly string[], label: string) {
  return sortedUnique(paths.map((value) => validateAbsolutePath(value, label)))
}

function normalizePorts(ports: readonly number[]) {
  return [...new Set(ports.map(validatePort))].sort(
    (left, right) => left - right
  )
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
}

function validateAbsolutePath(value: string, label: string) {
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`)
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} contains a newline`)
  }
  if (!value.startsWith('/')) throw new Error(`${label} must be absolute`)
  return value
}

function validatePort(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('loopback port must be an integer from 1 through 65535')
  }
  return value
}

function escapeSeatbeltLiteral(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
