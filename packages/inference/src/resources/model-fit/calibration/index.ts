import type {
  CalibrationFixture,
  ModelFitPlatform,
  PlatformCalibration
} from '@/resources/model-fit/types'
import { DARWIN_ARM64_CALIBRATION } from '@/resources/model-fit/calibration/darwin-arm64'
import { DARWIN_X64_CALIBRATION } from '@/resources/model-fit/calibration/darwin-x64'
import { LINUX_ARM64_CALIBRATION } from '@/resources/model-fit/calibration/linux-arm64'
import { LINUX_X64_CALIBRATION } from '@/resources/model-fit/calibration/linux-x64'
import { LINUX_X64_VULKAN_CALIBRATION } from '@/resources/model-fit/calibration/linux-x64-vulkan'
import { WIN32_X64_CALIBRATION } from '@/resources/model-fit/calibration/win32-x64'
import { WIN32_X64_VULKAN_CALIBRATION } from '@/resources/model-fit/calibration/win32-x64-vulkan'
import { WIN32_X64_VULKAN_SHARED_CALIBRATION } from '@/resources/model-fit/calibration/win32-x64-vulkan-shared'

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
    'darwin-x64': DARWIN_X64_CALIBRATION,
    'linux-arm64': LINUX_ARM64_CALIBRATION,
    'linux-x64': LINUX_X64_CALIBRATION,
    'win32-x64': WIN32_X64_CALIBRATION
  },
  gpuPlatforms: {
    'linux-x64:vulkan': LINUX_X64_VULKAN_CALIBRATION,
    'win32-x64:vulkan': WIN32_X64_VULKAN_CALIBRATION
  },
  sharedGpuPlatforms: {
    'win32-x64:vulkan': WIN32_X64_VULKAN_SHARED_CALIBRATION
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

/**
 * Looks up GPU-resident coefficients for a platform on a specific backend.
 *
 * Keyed by backend as well as platform because a `linux-x64` host may run
 * Vulkan, CUDA or ROCm, and their buffers differ — unlike the CPU fixtures,
 * where one platform entry is accepted as covering every backend.
 *
 * @returns `undefined` when that pair has not been measured, which assesses as
 *   `unknown` rather than borrowing another backend's coefficients.
 */
export function getGpuCalibration(
  platform: ModelFitPlatform,
  backend: string
): PlatformCalibration | undefined {
  const calibration = CALIBRATION.gpuPlatforms?.[`${platform}:${backend}`]
  if (!calibration || !calibration.validated) return undefined
  return calibration
}

/**
 * Looks up integrated-GPU coefficients, spent against the system budget. The
 * gap from the device fixture is large: `win32-x64:vulkan` fits a weight ratio
 * of 1.02 against the card's memory and 2.04 against system RAM.
 *
 * @returns `undefined` when unmeasured, which assesses as `unknown` rather
 *   than borrowing the platform's CPU-forced coefficients.
 */
export function getSharedGpuCalibration(
  platform: ModelFitPlatform,
  backend: string
): PlatformCalibration | undefined {
  const calibration = CALIBRATION.sharedGpuPlatforms?.[`${platform}:${backend}`]
  if (!calibration || !calibration.validated) return undefined
  return calibration
}
