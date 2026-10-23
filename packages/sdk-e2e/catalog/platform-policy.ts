/** Per-platform client policy, as data. */
export interface PlatformPolicy {
  /**
   * Which bootstrap download plan to use. Mobile fetches through the app's own storage and cannot
   * use the desktop concurrency.
   */
  downloadTarget: 'desktop' | 'mobile'

  /**
   * Milliseconds to sleep after a successful `unloadModel()` before the next load starts allocating
   * on top. Mobile needs a tick for the kernel to release the pages and reclaim the mmap regions:
   * without it the next load arrives while the previous model is still resident, and the GGML
   * allocator crashes on iOS while Scudo's mmap fails on Android with "internal map failure".
   * Empirically 200 ms is enough; no desktop leg needs it.
   */
  unloadSettleMs: number
}

export const PLATFORM_POLICY: Record<string, PlatformPolicy> = {
  desktop: { downloadTarget: 'desktop', unloadSettleMs: 0 },
  electron: { downloadTarget: 'desktop', unloadSettleMs: 0 },
  snap: { downloadTarget: 'desktop', unloadSettleMs: 0 },
  mobile: { downloadTarget: 'mobile', unloadSettleMs: 200 },
  python: { downloadTarget: 'desktop', unloadSettleMs: 0 }
}

/** The policy for a leg, by the first segment of its platform label. */
export function policyFor(platform: string): PlatformPolicy {
  const policy = PLATFORM_POLICY[platform.split('-')[0] ?? '']
  if (!policy) throw new Error(`no platform policy for "${platform}"`)
  return policy
}
