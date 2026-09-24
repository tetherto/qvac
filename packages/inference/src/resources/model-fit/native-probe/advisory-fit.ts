import type { AbortSignal } from 'bare-abort-controller'

import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'
import type { CanonicalModelType, NativeProbeFit, NativeProbeVerdict } from '@/schemas/index'
import { classifyFit } from '@/resources/model-fit/native-probe/classify-fit'
import { createFitRequest } from '@/resources/model-fit/native-probe/create-fit-request'
import { runFit as runFitDefault } from '@/resources/model-fit/native-probe/run-fit'

/**
 * Shorter than the supervisor's own 60s default: this check sits in front of a
 * real load, so a wedged child must not hold the load for a full minute. Every
 * expiry is `unknown` and the load continues.
 */
const ADVISORY_FIT_TIMEOUT_MS = 30_000

/**
 * The base every engine's fitter withholds by default. Made explicit here
 * because the resident-model reserve is added to it: setting a margin at all
 * replaces the engine default, so the base has to travel with it. It is also
 * the headroom `withMachineBudget` leaves on the system budget.
 */
const ADVISORY_FIT_BASE_MARGIN_MIB = 1024

/**
 * Names the headroom policy: the fitter withholds
 * `ADVISORY_FIT_BASE_MARGIN_MIB` plus the on-disk bytes of every model resident
 * in this worker, and a `fit` is then judged against what the system reports
 * free, less the same base.
 *
 * `assessModelFit` applies a different policy, `interactive-v1`: withhold 20%,
 * capped at 2 GiB desktop and 1 GiB mobile, against a budget the SDK computed.
 * Reconciling the two means one entry point owning both bases — see the
 * precedence note on `nativeProbeFitSchema`.
 */
const NATIVE_PROBE_ESTIMATOR_VERSION = 'native-probe-v2'

const BYTES_PER_MIB = 1024 * 1024

/**
 * `fit` and `does-not-fit` are projections of the load the SDK is about to run,
 * not admission decisions. The real loader neither consumes nor verifies the
 * fitted plan, so neither verdict is denial-grade and no verdict changes the
 * load.
 *
 * The outcome is the wire shape: `loadModel` hands it to the model registry and
 * `getLoadedModelInfo` returns it, so no caller has to read a verdict out of a
 * log line.
 */
export type AdvisoryFitVerdict = NativeProbeVerdict

export type AdvisoryFitOutcome = NativeProbeFit

export interface AdvisoryFitInput {
  modelId: string
  modelType: CanonicalModelType
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  isShardedModel: boolean
}

/**
 * Injection seams. Every field defaults to the real runtime dependency; tests
 * substitute them rather than mocking modules.
 */
export interface AdvisoryFitOptions {
  signal?: AbortSignal
  enabled?: boolean
  mobile?: boolean
  timeoutMs?: number
  runFit?: typeof runFitDefault
  logger?: Logger
  availableSystemBytes?: () => Promise<number | undefined>
  residentModelBytes?: () => Promise<number>
}

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no'])

/**
 * On by default; `QVAC_ADVISORY_MODEL_FIT=0` (or `false`/`off`/`no`) is the
 * operator opt-out — the escape hatch for a load-heavy startup path or a
 * runtime whose operator would rather not pay for it. Any other value, including
 * unset, leaves the check on.
 *
 * The worker environment and the mobile runtime flag are imported lazily. Both
 * modules reach Bare-only bindings, and resolving them eagerly would make this
 * orchestration untestable outside a Bare runtime.
 */
async function resolveEnabled(explicit: boolean | undefined): Promise<boolean> {
  if (explicit !== undefined) return explicit
  const { getValidatedEnv } = await import('@/runtime/env')
  const value = getValidatedEnv().QVAC_ADVISORY_MODEL_FIT
  return value === undefined || !DISABLED_VALUES.has(value.toLowerCase())
}

async function resolveMobile(explicit: boolean | undefined): Promise<boolean> {
  if (explicit !== undefined) return explicit
  const { isMobile } = await import('@/runtime/state')
  return isMobile()
}

/**
 * Sums the on-disk weight sizes of every model currently registered in this
 * worker. The fallback for a host whose memory sample is unavailable, where
 * models this worker loaded are the one part of the machine's usage it can
 * still account for.
 *
 * Advisory and fail-open like everything else here: any failure to stat a file
 * contributes zero rather than an error.
 */
async function defaultResidentModelBytes(): Promise<number> {
  const [{ getAllModelIds, getModelInfo }, { promises: fsPromises }] = await Promise.all([
    import('@/runtime/model-registry'),
    import('bare-fs')
  ])
  let bytes = 0
  for (const id of getAllModelIds()) {
    const info = getModelInfo(id)
    if (info === null) continue
    try {
      const stats = (await fsPromises.stat(info.path)) as { size: number }
      bytes += stats.size
    } catch {
      // Unreadable path: contribute nothing rather than fail the check.
    }
  }
  return bytes
}

const PROVENANCE = {
  basis: 'native-probe',
  estimatorVersion: NATIVE_PROBE_ESTIMATOR_VERSION
} as const

function unknown(reason: string, message?: string): AdvisoryFitOutcome {
  return message === undefined
    ? { ...PROVENANCE, verdict: 'unknown', reason }
    : { ...PROVENANCE, verdict: 'unknown', reason, message }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MIB)} MiB`
}

/**
 * What the operating system would give back, which no backend reports. Metal
 * answers with its working-set allowance minus this process's own allocations,
 * so another application's resident pages read as free, and the host figure
 * counts little beyond wired and compressed memory.
 */
async function defaultAvailableSystemBytes(): Promise<number | undefined> {
  const { getResourceCollector } = await import('@/resources/instance')
  const collector = getResourceCollector()
  if (!collector) return undefined
  const { totalBytes, usedBytes } = collector.sample().memory
  if (totalBytes.status !== 'supported' || usedBytes.status !== 'supported') return undefined
  return Math.max(0, totalBytes.value - usedBytes.value)
}

/**
 * Whether the device's allocations come out of the pool the system budget
 * measures. Host bytes always do; device bytes do only where every allocation
 * is system RAM, which is what `boundBySystemMemory` decides.
 */
async function deviceBytesCountAgainstSystem(): Promise<boolean> {
  const [{ getResourceCollector }, { boundBySystemMemory }, { detectPlatform }] = await Promise.all(
    [
      import('@/resources/instance'),
      import('@/resources/model-fit/assess'),
      import('@/resources/model-fit/platform')
    ]
  )
  const collector = getResourceCollector()
  // Unknown counts them: admitting a load that cannot decode is the failure
  // this check exists to stop, and refusing one that would have fitted is
  // advisory only.
  if (!collector) return true
  const resources = { capabilities: collector.getCapabilities(), sample: collector.sample() }
  return boundBySystemMemory(resources, detectPlatform())
}

/**
 * Peak the projection places on the pool the system budget measures. A
 * discrete card's memory is not that pool, so charging its bytes here would
 * refuse a load the machine can hold.
 */
function projectedDemandBytes(
  outcome: AdvisoryFitOutcome,
  countDevice: boolean
): number | undefined {
  const projection = outcome.projection
  if (projection === undefined) return undefined
  if (projection.deviceBytes === undefined && projection.hostBytes === undefined) return undefined
  return (countDevice ? (projection.deviceBytes ?? 0) : 0) + (projection.hostBytes ?? 0)
}

/**
 * Judges a `fit` against the machine. The fitter decides placement and reports
 * what the load costs; only this side knows what is free, so only this side can
 * refuse on capacity.
 *
 * The margin cannot carry this. It is subtracted from each device's own free,
 * and a device whose total sits below the machine's — Metal caps its allowance
 * near 74% of system memory — would be charged the shortfall twice.
 *
 * A projection with no byte totals leaves the engine's verdict standing.
 */
function withMachineBudget(
  outcome: AdvisoryFitOutcome,
  availableBytes: number | undefined,
  countDevice: boolean
): AdvisoryFitOutcome {
  if (outcome.verdict !== 'fit' || availableBytes === undefined) return outcome

  const demand = projectedDemandBytes(outcome, countDevice)
  if (demand === undefined) return outcome

  const budget = availableBytes - ADVISORY_FIT_BASE_MARGIN_MIB * BYTES_PER_MIB
  if (demand <= budget) return outcome

  return {
    ...outcome,
    verdict: 'does-not-fit',
    reason: 'exceeds-available-memory',
    message: `needs ${mib(demand)} against a ${mib(Math.max(0, budget))} budget (${mib(availableBytes)} free, less a ${ADVISORY_FIT_BASE_MARGIN_MIB} MiB margin)`
  }
}

/** The device and host totals, for the engines that measure them. */
function footprint(outcome: AdvisoryFitOutcome): string {
  const projection = outcome.projection
  if (projection?.deviceBytes === undefined) return ''
  const host = projection.hostBytes === undefined ? '' : `, host ${mib(projection.hostBytes)}`
  return ` — device ${mib(projection.deviceBytes)}${host}`
}

function report(logger: Logger, input: AdvisoryFitInput, outcome: AdvisoryFitOutcome): void {
  const prefix = `[advisory-fit:${input.modelType}:${input.modelId}]`

  if (outcome.verdict === 'fit') {
    const plan = outcome.plan
    logger.info(
      `${prefix} projected to fit (advisory only)${
        plan === undefined
          ? footprint(outcome)
          : ` — nCtx ${plan.nCtx}, nGpuLayers ${plan.nGpuLayers} across ${plan.nGpuDevices} GPU device(s)`
      }`
    )
    return
  }

  if (outcome.verdict === 'does-not-fit') {
    logger.warn(
      `${prefix} projected not to fit (advisory only — the load continues unchanged)${footprint(
        outcome
      )}: ${outcome.reason}${outcome.message === undefined ? '' : ` (${outcome.message})`}`
    )
    return
  }

  // `unsupported-load` covers every load this check refuses up front — a model
  // type with no fitter, a companion set that did not resolve — so at `info` it
  // would tag those loads on every start. `debug` for those; `info` where a
  // fitter ran (or should have) and produced no verdict, because there "why was
  // there no evidence" is the most useful thing this check can report.
  const line = `${prefix} no fit evidence: ${outcome.reason}${
    outcome.message === undefined ? '' : ` (${outcome.message})`
  }`
  if (outcome.reason === 'unsupported-load') {
    logger.debug(line)
    return
  }
  logger.info(line)
}

/**
 * Runs the advisory fit check for a load that is about to start, against the
 * fitter belonging to the engine that will run it.
 *
 * Fail-open by construction: an unsupported shape, a crashed or wedged child, a
 * malformed response, and an unexpected internal error all resolve to `unknown`
 * and the caller proceeds with the ordinary load path. This function never
 * throws and never rejects.
 */
export async function runAdvisoryFitCheck(
  input: AdvisoryFitInput,
  options: AdvisoryFitOptions = {}
): Promise<AdvisoryFitOutcome> {
  let logger: Logger | undefined = options.logger
  try {
    logger ??= getEngineLogger()
    if (!(await resolveEnabled(options.enabled))) return unknown('disabled')

    const mobile = await resolveMobile(options.mobile)

    const availableBytes = await (options.availableSystemBytes ?? defaultAvailableSystemBytes)()
    const residentBytes = await (options.residentModelBytes ?? defaultResidentModelBytes)()
    const residentReserveMiB = Math.ceil(residentBytes / BYTES_PER_MIB)

    // Always sent, even with a zero reserve: relying on the engine default for
    // the base margin would leave two sources of truth that match today and
    // diverge silently if an engine default moves.
    const plan = createFitRequest({
      modelType: input.modelType,
      modelPath: input.modelPath,
      modelConfig: input.modelConfig,
      artifacts: input.artifacts,
      isShardedModel: input.isShardedModel,
      marginBytes: (ADVISORY_FIT_BASE_MARGIN_MIB + residentReserveMiB) * BYTES_PER_MIB
    })

    if (!plan.supported) {
      const outcome = unknown('unsupported-load', plan.detail)
      report(logger, input, outcome)
      return outcome
    }

    const result = await (options.runFit ?? runFitDefault)(plan.probe, {
      mobile,
      timeoutMs: options.timeoutMs ?? ADVISORY_FIT_TIMEOUT_MS,
      ...(options.signal !== undefined && { signal: options.signal })
    })

    const outcome =
      result.status === 'completed'
        ? withMachineBudget(
            classifyFit(result.probe, PROVENANCE),
            availableBytes,
            await deviceBytesCountAgainstSystem()
          )
        : unknown(result.reason, result.message)
    report(logger, input, outcome)
    return outcome
  } catch (error) {
    const outcome = unknown(
      'internal-error',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
    try {
      if (logger !== undefined) report(logger, input, outcome)
    } catch {
      // A failing logger must not turn an advisory check into a load failure.
    }
    return outcome
  }
}
