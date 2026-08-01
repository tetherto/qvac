export const WORKLET_ARGV_LAYOUT = {
  runtime: 0,
  entry: 1,
  optionsJson: 2
} as const

export function createSyncWorkletArgv(options: {
  readonly storagePath: string
  readonly invite?: string
}) {
  return [
    'react-native-bare-kit',
    'sync.js',
    JSON.stringify({
      storagePath: options.storagePath,
      ...(options.invite ? { invite: options.invite } : {})
    })
  ]
}

export function parseSyncWorkletArgv(argv: readonly string[]) {
  const encoded = argv[WORKLET_ARGV_LAYOUT.optionsJson]
  if (!encoded) throw new Error('Mobile Sync Worklet options are required')
  const parsed: unknown = JSON.parse(encoded)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('storagePath' in parsed) ||
    typeof parsed.storagePath !== 'string' ||
    parsed.storagePath.length === 0
  ) {
    throw new Error('Mobile Sync Worklet storagePath is required')
  }
  if (
    'invite' in parsed &&
    parsed.invite !== undefined &&
    typeof parsed.invite !== 'string'
  ) {
    throw new Error('Mobile Sync Worklet invite must be a string')
  }
  return {
    storagePath: parsed.storagePath,
    invite:
      'invite' in parsed && typeof parsed.invite === 'string'
        ? parsed.invite
        : undefined
  }
}
