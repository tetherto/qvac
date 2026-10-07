import type { FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

/**
 * Why a run produced no projection. Every one of these is absence of evidence,
 * so the caller proceeds with the load it was going to run anyway.
 */
export type FitRunUnknownReason =
  | 'unsupported-platform'
  | 'spawn-failed'
  | 'timeout'
  | 'cancelled'
  | 'crashed'
  | 'invalid-response'
  | 'invocation-error'

/** The contract both isolation strategies answer with. */
export type FitRunResult =
  | { status: 'completed'; probe: FitProbeResult }
  | {
      status: 'unknown'
      reason: FitRunUnknownReason
      message: string
      stderrTail?: string
    }
