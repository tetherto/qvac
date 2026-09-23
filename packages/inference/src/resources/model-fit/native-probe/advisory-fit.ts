import type { AbortSignal } from 'bare-abort-controller'
import type { FitLlamaResult } from '@qvac/model-fit/process'

import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'
import type { CanonicalModelType, NativeProbeFit, NativeProbeVerdict } from '@/schemas/index'
import { createLlamaFitRequest } from '@/resources/model-fit/native-probe/create-llama-fit-request'
import type { runIsolatedFit } from '@/resources/model-fit/native-probe/run-isolated-fit'

/**
 * Shorter than the supervisor's own 60s default: this check sits in front of a
 * real load, so a wedged child must not hold the load for a full minute. Every
 * expiry is `unknown` and the load continues.
 */
const ADVISORY_FIT_TIMEOUT_MS = 30_000

/**
 * `@qvac/model-fit`'s own default margin. Made explicit here because the
 * resident-model reserve below is *added* to it: setting `marginMiB` at all
 * replaces the package default, so the base has to travel with the reserve.
 */
const ADVISORY_FIT_BASE_MARGIN_MIB = 1024

/**
 * Names the headroom policy: the fitter withholds
 * `ADVISORY_FIT_BASE_MARGIN_MIB` plus the on-disk bytes of every model resident
 * in this worker, and a `fit` is then judged against what the system reports
 * free, less the same base.
 *
 * Deliberately *not* `interactive-v1` (withhold 20%, cap 2 GiB desktop / 1 GiB
 * mobile), which `assessModelFit` applies to a budget the SDK computed.
 * Reconciling the two means one entry point owning both bases — see the
 * precedence note on `nativeProbeFitSchema`.
 */
const NATIVE_PROBE_ESTIMATOR_VERSION = 'native-probe-v2'

const BYTES_PER_MIB = 1024 * 1024

/** The fitter appends this row after the devices it assigned to. */
const HOST_ROW = 'host'

/**
 * `fit` and `does-not-fit` are projections of the load the SDK is about to run,
 * not admission decisions. `@qvac/model-fit` duplicates the loader's policy for
 * this experiment and the real loader neither consumes nor verifies the fitted
 * plan, so neither verdict is denial-grade and no verdict changes the load.
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
  runFit?: typeof runIsolatedFit
  logger?: Logger
  availableSystemBytes?: () => Promise<number | undefined>
  residentModelBytes?: () => Promise<number>
}

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no'])

/**
 * On by default; `QVAC_ADVISORY_MODEL_FIT=0` (or `false`/`off`/`no`) is the
 * operator opt-out — the escape hatch for a load-heavy startup path or a
 * runtime where the disposable child cannot spawn. Any other value, including
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
 * worker. Since `@qvac/model-fit@0.8.0` (qvac-fabric#214) the fit child budgets
 * against system-wide availability (total − wired − compressor), so weights the
 * worker holds *wired* on the GPU are already visible to it. What the child
 * still cannot see is the unwired remainder — mmap'd host-side layers and KV of
 * resident models — which the OS reports as evictable right up until a decode
 * needs it resident. Measured consequence on 0.7.0 (where the child saw a fully
 * idle device): a verdict correct on an idle machine admitted a load that could
 * not decode with another model loaded.
 *
 * Reserving the resident weight bytes through `marginMiB` keeps that footprint
 * in the child's budget. Where those weights are wired this now double-counts
 * and the verdict turns conservative — deliberately so: the measured failure
 * modes punish optimism (loads that cannot decode), not caution.
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

/**
 * Also lazy: the desktop supervisor pulls the Bare process launcher, and a
 * disabled check must not load it. Mobile uses in-process `fitParamsAsync` instead
 * of spawn (`bare-runtime/spawn` stays deferred from the mobile pack).
 */
async function resolveRunFit(
  explicit: typeof runIsolatedFit | undefined,
  mobile: boolean
): Promise<typeof runIsolatedFit> {
  if (explicit !== undefined) return explicit
  if (mobile) {
    const { runInProcessFit } =
      await import('@/resources/model-fit/native-probe/run-in-process-fit')
    return runInProcessFit as typeof runIsolatedFit
  }
  return (await import('@/resources/model-fit/native-probe/run-isolated-fit')).runIsolatedFit
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

/**
 * The fitter's per-device measurements. They come from a second no-alloc
 * probe, and a probe that fails is reported as an absent projection.
 */
function projectionOf(result: FitLlamaResult): AdvisoryFitOutcome['projection'] {
  const rows = result.projection
  if (rows === undefined || rows.length === 0) return undefined
  return { devices: rows }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MIB)} MiB`
}

/**
 * What the operating system would give back, which no backend reports. Metal
 * answers with its working-set allowance minus this process's own allocations,
 * so another application's resident pages read as free, and the host row counts
 * little beyond wired and compressed memory.
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
 * Whether a device's allocations come out of the pool the system budget
 * measures. The host row always does. A device row does only where every
 * allocation is system RAM, which is what `boundBySystemMemory` decides.
 */
async function deviceRowsCountAgainstSystem(): Promise<boolean> {
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
 * discrete card's memory is not that pool, so charging its rows here would
 * refuse a load the machine can hold.
 */
function projectedDemandBytes(
  outcome: AdvisoryFitOutcome,
  countDevices: boolean
): number | undefined {
  const devices = outcome.projection?.devices
  if (devices === undefined || devices.length === 0) return undefined
  const counted = countDevices ? devices : devices.filter((device) => device.name === HOST_ROW)
  if (counted.length === 0) return undefined
  return counted.reduce(
    (total, device) => total + device.modelBytes + device.contextBytes + device.computeBytes,
    0
  )
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
 * A projection with no devices leaves the fitter's verdict standing.
 */
function withMachineBudget(
  outcome: AdvisoryFitOutcome,
  availableBytes: number | undefined,
  countDevices: boolean
): AdvisoryFitOutcome {
  if (outcome.verdict !== 'fit' || availableBytes === undefined) return outcome

  const demand = projectedDemandBytes(outcome, countDevices)
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

function classify(result: FitLlamaResult): AdvisoryFitOutcome {
  const projection = projectionOf(result)

  if (result.status === 0) {
    return {
      ...PROVENANCE,
      verdict: 'fit',
      reason: result.reason,
      plan: {
        nCtx: result.nCtx,
        nGpuLayers: result.nGpuLayers,
        nGpuDevices: result.nGpuDevices
      },
      ...(projection !== undefined && { projection })
    }
  }
  if (result.status === 1) {
    return {
      ...PROVENANCE,
      verdict: 'does-not-fit',
      reason: result.reason,
      ...(projection !== undefined && { projection })
    }
  }
  // `model-unreadable`, `no-backend-device`, and `unsupported-config` are all
  // absence of evidence, not evidence of insufficiency.
  return unknown(result.reason)
}

function report(logger: Logger, input: AdvisoryFitInput, outcome: AdvisoryFitOutcome): void {
  const prefix = `[advisory-fit:${input.modelType}:${input.modelId}]`

  if (outcome.verdict === 'fit') {
    const plan = outcome.plan
    logger.info(
      `${prefix} projected to fit (advisory only)${
        plan === undefined
          ? ''
          : ` — nCtx ${plan.nCtx}, nGpuLayers ${plan.nGpuLayers} across ${plan.nGpuDevices} GPU device(s)`
      }`
    )
    return
  }

  if (outcome.verdict === 'does-not-fit') {
    logger.warn(
      `${prefix} projected not to fit (advisory only — the load continues unchanged): ${
        outcome.reason
      }${outcome.message === undefined ? '' : ` (${outcome.message})`}`
    )
    return
  }

  // `unsupported-load` covers every load this check refuses up front — all
  // non-llama.cpp model types — so at `info` it would tag every whisper/tts/ocr
  // load on every start. `debug` for those; `info` where a fitter ran (or
  // should have) and produced no verdict, because there "why was there no
  // evidence" is the most useful thing this check can report.
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
 * Runs the advisory llama.cpp fit check for a load that is about to start.
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
    const plan = createLlamaFitRequest({
      modelType: input.modelType,
      modelPath: input.modelPath,
      modelConfig: input.modelConfig,
      artifacts: input.artifacts,
      isShardedModel: input.isShardedModel
    })

    if (!plan.supported) {
      const outcome = unknown('unsupported-load', plan.detail)
      report(logger, input, outcome)
      return outcome
    }

    const availableBytes = await (options.availableSystemBytes ?? defaultAvailableSystemBytes)()
    const residentBytes = await (options.residentModelBytes ?? defaultResidentModelBytes)()
    const residentReserveMiB = Math.ceil(residentBytes / BYTES_PER_MIB)

    const runFit = await resolveRunFit(options.runFit, mobile)
    // Always sent, even with a zero reserve: relying on the addon default for
    // the base margin would leave two sources of truth that match today and
    // diverge silently if the addon default moves.
    const result = await runFit(
      plan.loadKind,
      { ...plan.config, marginMiB: ADVISORY_FIT_BASE_MARGIN_MIB + residentReserveMiB },
      {
        timeoutMs: options.timeoutMs ?? ADVISORY_FIT_TIMEOUT_MS,
        ...(options.signal !== undefined && { signal: options.signal })
      }
    )

    const outcome =
      result.status === 'completed'
        ? withMachineBudget(
            classify(result.result),
            availableBytes,
            await deviceRowsCountAgainstSystem()
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
