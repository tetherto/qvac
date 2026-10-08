import os from 'bare-os'

import type { ModelFitPlatform } from '@/resources/model-fit/types'

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
    // Listed for completeness rather than reach: no engine addon is built for
    // win32-arm64 (`@qvac/llm-llamacpp/prebuilds` has no such target, and no
    // windows-arm runner exists to build one), so nothing on that platform can
    // load a model today. Calibrating it needs that build first, not a fixture.
    case 'win32-arm64':
    case 'android-arm64':
    case 'ios-arm64':
      return key
    default:
      return undefined
  }
}
