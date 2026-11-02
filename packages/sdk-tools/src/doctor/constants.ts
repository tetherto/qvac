// Keep in sync with packages/sdk/commands/bundle/constants.ts — until the SDK
// re-exports these from @qvac/sdk/commands, the doctor's defaults are
// duplicated here and will silently drift if only one side adds a host.
export const DEFAULT_SDK_NAME = '@qvac/sdk'

export const DEFAULT_HOSTS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
]
