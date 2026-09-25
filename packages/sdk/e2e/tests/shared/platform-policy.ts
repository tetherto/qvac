/**
 * Per-platform client policy, as data.
 *
 * Two settings that are not about any one test and not about any one model, so
 * neither the catalog nor the resource table was the right home for them. They
 * lived as literals inside each consumer entry, which meant a client in
 * another language had no way to learn them and would either guess or crash.
 */
export interface PlatformPolicy {
  /**
   * Which bootstrap download plan to use. Mobile fetches through the app's own
   * storage and cannot use the desktop concurrency.
   */
  downloadTarget: 'desktop' | 'mobile'

  /**
   * Milliseconds to sleep after a successful `unloadModel()` before the next
   * load starts allocating on top.
   *
   * iOS needs it: the kernel does not release pages the moment a Bare
   * worklet's V8 isolate drops its handles, and a load arriving at the
   * still-resident moment crashes inside the GGML allocator with
   * EXC_CRASH/SIGABRT. This is a real crash, not a tuning nicety.
   *
   * Desktop does not: `unloadModel` over the IPC socket returns with the
   * worker process having already freed the memory, and the kernel reclaims
   * fast.
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

/**
 * The policy for a leg, by the first segment of its platform label.
 *
 * Segment, not the whole label, because the label carries the OS
 * (`mobile-ios`, `desktop-macos`) and these two settings do not differ by OS
 * today. A setting that needs to would move to the full label, and the lookup
 * is the only place that has to change.
 */
export function policyFor(platform: string): PlatformPolicy {
  const policy = PLATFORM_POLICY[platform.split('-')[0] ?? '']
  if (!policy) throw new Error(`no platform policy for "${platform}"`)
  return policy
}
