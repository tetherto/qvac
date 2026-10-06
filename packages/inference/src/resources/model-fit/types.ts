/** A memory bound. `lower` is the optimistic end, `upper` the conservative one. */
export interface ByteRange {
  lower: number
  upper: number
}

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
