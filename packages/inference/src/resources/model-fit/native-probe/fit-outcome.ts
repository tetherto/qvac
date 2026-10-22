import type { FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

/**
 * Why a run produced no projection. Every one of these is absence of evidence,
 * so the caller proceeds with the load it was going to run anyway.
 */
export type FitRunUnknownReason = 'cancelled' | 'crashed' | 'invocation-error' | 'timeout'

export type FitRunResult =
  | { status: 'completed'; probe: FitProbeResult }
  | { status: 'unknown'; reason: FitRunUnknownReason; message: string }
