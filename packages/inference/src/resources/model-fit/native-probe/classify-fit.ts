import type { NativeProbeFit, NativeProbeProjection, NativeProbeVerdict } from '@/schemas/index'
import type { FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

type LlamaProbe = Extract<FitProbeResult, { engine: 'llm-llamacpp' | 'embed-llamacpp' }>

/** The llama fitters append a host row after the devices they assigned to. */
const HOST_ROW = 'host'

/** ggml's own name for the CPU backend device, which the fitter may assign to. */
const CPU_DEVICE = 'CPU'

function isLlama(probe: FitProbeResult): probe is LlamaProbe {
  return probe.engine === 'llm-llamacpp' || probe.engine === 'embed-llamacpp'
}

/**
 * `error` is the engine reporting it could not read the model or find a backend
 * device: absence of evidence, not evidence of insufficiency.
 */
function verdictFor(status: 'fits' | 'does-not-fit' | 'error'): NativeProbeVerdict {
  if (status === 'fits') return 'fit'
  if (status === 'does-not-fit') return 'does-not-fit'
  return 'unknown'
}

/**
 * The diffusion fitter reports a placement rather than a reason string.
 * `changed` means it reached a fitting arrangement only by moving modules
 * between backends, which is why the status is already `does-not-fit`.
 */
function diffusionReason(result: { status: string; changed: boolean; backend: string }): string {
  if (result.status === 'fits') return 'fits'
  if (result.status === 'error') return 'model-unreadable'
  return result.changed ? `does-not-fit-as-configured (${result.backend})` : 'does-not-fit'
}

function reasonFor(probe: FitProbeResult): string {
  return probe.engine === 'diffusion-cpp' ? diffusionReason(probe.result) : probe.result.reason
}

type Breakdown = Pick<NativeProbeProjection, 'weightsBytes' | 'contextBytes' | 'computeBytes'>

function sumOf(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0)
}

function breakdown(
  weights: number | undefined,
  context: number | undefined,
  compute: number | undefined
): Breakdown {
  return {
    ...(weights !== undefined && { weightsBytes: weights }),
    ...(context !== undefined && { contextBytes: context }),
    ...(compute !== undefined && { computeBytes: compute })
  }
}

/**
 * The parts of `deviceBytes` the engine separates. Audiogen reports a peak
 * across pipeline phases and diffusion a per-module table, neither of which
 * divides into these three, so both come back empty.
 *
 * The llama rows are summed over the same devices the engine's own
 * `deviceBytes` covers, which is every row but `host`.
 */
function breakdownFor(probe: FitProbeResult): Breakdown {
  if (isLlama(probe)) {
    const devices = probe.result.devices.filter((device) => device.name !== HOST_ROW)
    return breakdown(
      sumOf(...devices.map((device) => device.modelBytes)),
      sumOf(...devices.map((device) => device.contextBytes)),
      sumOf(...devices.map((device) => device.computeBytes))
    )
  }

  // Whisper names its parts `kvBytes` and `computeBytes`, parakeet splits
  // compute across encoder and decoder; an engine fills one set or the other.
  if (probe.engine === 'asr-ggml') {
    const result = probe.result
    // A VAD model's weights are inside `deviceBytes`, so they belong in the
    // weights the breakdown divides it into.
    return breakdown(
      sumOf(result.weightsBytes, result.vadBytes),
      sumOf(result.kvBytes, result.decoderStateBytes),
      sumOf(result.computeBytes, result.encoderComputeBytes, result.decoderComputeBytes)
    )
  }

  if (probe.engine === 'bci-whispercpp') {
    const result = probe.result
    return breakdown(result.weightsBytes, result.kvBytes, result.computeBytes)
  }

  if (probe.engine === 'tts-ggml') {
    const result = probe.result
    return breakdown(
      result.weightsBytes,
      result.stateBytes,
      sumOf(result.lmComputeBytes, result.codecComputeBytes)
    )
  }

  return {}
}

function llamaProjection(probe: LlamaProbe): NativeProbeProjection {
  const first = probe.result.devices.find(
    (device) => device.name !== HOST_ROW && device.name !== CPU_DEVICE
  )

  return {
    deviceBytes: probe.result.deviceBytes,
    hostBytes: probe.result.hostBytes,
    ...breakdownFor(probe),
    ...(first !== undefined && {
      deviceName: first.name,
      deviceFreeBytes: first.freeBytes,
      deviceTotalBytes: first.totalBytes
    })
  }
}

function projectionFor(probe: FitProbeResult): NativeProbeProjection {
  if (probe.engine === 'diffusion-cpp') {
    return { deviceName: probe.result.backend, report: probe.result.report }
  }
  if (isLlama(probe)) return llamaProjection(probe)

  const result = probe.result
  return {
    deviceName: result.deviceName,
    deviceBytes: result.deviceBytes,
    hostBytes: result.hostBytes,
    deviceFreeBytes: result.deviceFreeBytes,
    deviceTotalBytes: result.deviceTotalBytes,
    report: result.report,
    ...breakdownFor(probe)
  }
}

/**
 * Only the llama fitters resolve a placement; the other engines' loads are not
 * layer-sliced across devices.
 *
 * `nGpuDevices` counts the devices the weights were actually placed on, less
 * the CPU backend device, which the fitter assigns to like any other but whose
 * demand is host memory.
 */
function planFor(probe: FitProbeResult): NativeProbeFit['plan'] {
  if (!isLlama(probe)) return undefined

  const assigned = probe.result.devices.filter(
    (device) => device.name !== HOST_ROW && device.name !== CPU_DEVICE && device.modelBytes > 0
  )

  return {
    nCtx: probe.result.ctxSize,
    nGpuLayers: probe.result.gpuLayers,
    nGpuDevices: assigned.length
  }
}

export function classifyFit(
  probe: FitProbeResult,
  provenance: { basis: 'native-probe'; estimatorVersion: string }
): NativeProbeFit {
  const verdict = verdictFor(probe.result.status)
  const plan = verdict === 'fit' ? planFor(probe) : undefined

  return {
    ...provenance,
    engine: probe.engine,
    verdict,
    reason: reasonFor(probe),
    ...(plan !== undefined && { plan }),
    ...(verdict !== 'unknown' && { projection: projectionFor(probe) })
  }
}
