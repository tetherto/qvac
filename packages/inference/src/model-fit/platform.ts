import os from 'bare-os'

/**
 * Platforms this assessment covers. A platform absent from this list assesses
 * as `unknown`, because nothing fixes the memory budget it would be judged
 * against.
 */
export type ModelFitPlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'
  | 'win32-arm64'
  | 'android-arm64'
  | 'ios-arm64'

/**
 * Maps the runtime's platform and architecture onto a platform this assessment
 * covers.
 *
 * @returns `undefined` for any pair outside that set, which assesses as
 *   `unknown`.
 */
export function detectPlatform(): ModelFitPlatform | undefined {
  const key = `${os.platform()}-${os.arch()}`
  switch (key) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'linux-arm64':
    case 'linux-x64':
    case 'win32-x64':
    // No engine addon is built for win32-arm64 (`@qvac/llm-llamacpp/prebuilds`
    // has no such target), so no load on it reaches a fitter.
    case 'win32-arm64':
    case 'android-arm64':
    case 'ios-arm64':
      return key
    default:
      return undefined
  }
}
