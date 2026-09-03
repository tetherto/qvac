import type {
  CalibrationFixture,
  ModelFitPlatform,
  PlatformCalibration
} from '@/resources/model-fit/types'
import { DARWIN_ARM64_CALIBRATION } from '@/resources/model-fit/calibration/darwin-arm64'
import { LINUX_X64_CALIBRATION } from '@/resources/model-fit/calibration/linux-x64'
import { WIN32_X64_CALIBRATION } from '@/resources/model-fit/calibration/win32-x64'

/**
 * Every platform this feature has coefficients for.
 *
 * A platform is added here only once the calibration harness has measured it
 * and a held-out model validated inside the bounds. Everything else assesses as
 * `unknown` — see `METHODOLOGY.md` next to this file.
 */
export const CALIBRATION: CalibrationFixture = {
  schemaVersion: 1,
  platforms: {
    'darwin-arm64': DARWIN_ARM64_CALIBRATION,
    'linux-x64': LINUX_X64_CALIBRATION,
    'win32-x64': WIN32_X64_CALIBRATION
  }
}

/**
 * Looks up the coefficients for a platform.
 *
 * @param platform - Runtime platform-arch pair.
 * @returns The calibration, or `undefined` when the platform is absent or its
 *   coefficients are still provisional. Both cases assess as `unknown`.
 */
export function getPlatformCalibration(
  platform: ModelFitPlatform
): PlatformCalibration | undefined {
  const calibration = CALIBRATION.platforms[platform]
  if (!calibration || !calibration.validated) return undefined
  return calibration
}
