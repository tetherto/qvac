import os from "bare-os";

export interface PlatformInfo {
  os: string;
  arch: string;
  totalMemory: number;
  availableMemory: number;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// On macOS (and iOS), os.freemem() returns only truly unallocated pages
// ("Pages free" from vm_stat), which is always tiny because the OS
// aggressively caches files in inactive/purgeable memory. The actual
// memory available for new allocations is much larger.
// We use totalMemory * fraction as a realistic estimate instead.
const AVAILABLE_MEMORY_FRACTION_DESKTOP = 0.7;
const AVAILABLE_MEMORY_FRACTION_MOBILE = 0.5;

function estimateAvailableMemory(
  totalMemory: number,
  platform: string,
): number {
  if (totalMemory <= 0) return 0;

  const fraction =
    platform === "ios" || platform === "android"
      ? AVAILABLE_MEMORY_FRACTION_MOBILE
      : AVAILABLE_MEMORY_FRACTION_DESKTOP;

  return Math.floor(totalMemory * fraction);
}

export function getPlatformInfo(): PlatformInfo {
  const platform = safeCall(() => os.platform(), "unknown");
  const totalMemory = safeCall(() => os.totalmem(), 0);

  return {
    os: platform,
    arch: safeCall(() => os.arch(), "unknown"),
    totalMemory,
    availableMemory: estimateAvailableMemory(totalMemory, platform),
  };
}
