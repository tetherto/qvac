import test from 'brittle'
import { estimateLlm, LLM_ESTIMATOR_VERSION } from '@/resources/model-fit/estimators/llm'
import { estimateWhisper } from '@/resources/model-fit/estimators/whisper'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
import { fitResidentMemory, kvObservation } from '@/resources/model-fit/calibration/fit'
import type { CalibrationPoint } from '@/resources/model-fit/calibration/fit'
import type { PlatformCalibration } from '@/resources/model-fit/types'
import type { GgufFacts, ModelResourceProfile } from '@/schemas/model-resource-profile'
import type { SystemResources } from '@/schemas/system-resources'
import type { ModelFitCandidate } from '@/schemas/assess-model-fit'

const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

const F16 = 2
const Q8_0 = 34 / 32

// Calibration with every scaling term zeroed so a test asserts the KV formula
// itself rather than a coefficient. Individual tests override what they need.
const FLAT_CALIBRATION: PlatformCalibration = {
  weightUpperCoeff: 1,
  fixedOverheadBytes: { lower: 0, upper: 0 },
  computeBufferBytesPerToken: { lower: 0, upper: 0 },
  audioWindowBytes: { lower: 0, upper: 0 },
  audioStreamingBytes: { lower: 0, upper: 0 },
  validated: true
}

function calibration(overrides: Partial<PlatformCalibration> = {}): PlatformCalibration {
  return { ...FLAT_CALIBRATION, ...overrides }
}

// A plain dense transformer: 32 blocks, 8 KV heads, 128-wide K and V.
function denseFacts(overrides: Partial<GgufFacts> = {}): GgufFacts {
  return {
    architecture: 'llama',
    blockCount: 32,
    headCount: 32,
    headCountKv: 8,
    keyLength: 128,
    valueLength: 128,
    embeddingLength: 4096,
    contextLength: 8192,
    ...overrides
  }
}

function profile(overrides: Partial<ModelResourceProfile> = {}): ModelResourceProfile {
  return {
    schemaVersion: 1,
    engine: 'llamacpp-completion',
    artifactBytes: 1_000_000_000,
    ggufFacts: denseFacts(),
    ...overrides
  }
}

function resources(
  options: {
    totalBytes?: number
    usedBytes?: number
    gpu?: boolean
    processUsedBytes?: number
    processAvailableBytes?: number
  } = {}
) {
  const total = options.totalBytes ?? 64 * GIB
  const used = options.usedBytes ?? 16 * GIB
  const provenance = { source: 'test', scope: 'system' as const }
  const processProvenance = { source: 'test', scope: 'process' as const }
  const processUsed =
    options.processUsedBytes === undefined
      ? ({ status: 'unavailable' } as const)
      : ({
          status: 'supported',
          value: options.processUsedBytes,
          provenance: processProvenance
        } as const)
  const processAvailable =
    options.processAvailableBytes === undefined
      ? ({ status: 'unavailable' } as const)
      : ({
          status: 'supported',
          value: options.processAvailableBytes,
          provenance: processProvenance
        } as const)

  const value: SystemResources = {
    capabilities: {
      cpu: { status: 'unavailable' },
      memory: { totalBytes: { status: 'supported', value: total, provenance } },
      gpus: options.gpu
        ? {
            status: 'supported',
            provenance,
            value: [
              {
                id: 'gpu0',
                name: { status: 'supported', value: 'Test GPU', provenance },
                vendor: { status: 'unavailable' },
                type: { status: 'unavailable' },
                driverName: { status: 'unavailable' },
                driverVersion: { status: 'unavailable' },
                drivers: {
                  vulkan: { status: 'unavailable' },
                  opencl: { status: 'unavailable' },
                  opengl: { status: 'unavailable' },
                  webgpu: { status: 'unavailable' },
                  metal: { status: 'supported', value: true, provenance },
                  direct3d11: { status: 'unavailable' },
                  direct3d12: { status: 'unavailable' },
                  cuda: { status: 'unavailable' },
                  levelZero: { status: 'unavailable' },
                  rocm: { status: 'unavailable' }
                },
                unifiedMemory: { status: 'supported', value: true, provenance },
                memoryTotalBytes: { status: 'unverified' }
              }
            ]
          }
        : { status: 'supported', provenance, value: [] }
    },
    sample: {
      sampledAt: 0,
      cpu: { status: 'unavailable' },
      memory: {
        usedBytes: { status: 'supported', value: used, provenance },
        totalBytes: { status: 'supported', value: total, provenance },
        processUsedBytes: processUsed,
        processAvailableBytes: processAvailable
      },
      gpus: { status: 'supported', provenance, value: [] }
    }
  }
  return value
}

function candidate(overrides: Partial<ModelFitCandidate> = {}): ModelFitCandidate {
  return {
    model: {
      name: 'TEST_MODEL',
      sha256Checksum: 'a'.repeat(64)
    },
    workload: { kind: 'llm', contextTokens: 4096 },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// LLM estimator — KV formula
// ---------------------------------------------------------------------------

test('estimateLlm: dense model KV matches the hand-computed cache', (t) => {
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0 }),
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return

  // 32 blocks × 8 KV heads × (128 + 128) elements × 4096 tokens × 2 bytes
  const expected = 32 * 8 * 256 * 4096 * F16
  t.is(expected, 512 * MIB, 'sanity: the hand-computed cache is 512 MiB')
  t.is(result.persistent.lower, expected, 'the cache is resident, so it lands in persistent')
  t.is(result.persistent.upper, expected, 'no GPU, so both bounds use the f16 default')
  t.is(result.estimatorVersion, LLM_ESTIMATOR_VERSION)
})

test('estimateLlm: a GPU widens the bound to span the q8_0 default', (t) => {
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0 }),
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: true
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return

  const elements = 32 * 8 * 256 * 4096
  t.is(result.persistent.lower, Math.ceil(elements * Q8_0), 'GPU default is q8_0')
  t.is(result.persistent.upper, elements * F16, 'CPU or OpenCL backend keeps f16')
  t.ok(result.assumptions.some((a) => a.includes('q8_0')))
})

test('estimateLlm: bitnet keeps f16 even with a GPU (flash attention is off)', (t) => {
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0, ggufFacts: denseFacts({ architecture: 'bitnet' }) }),
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: true
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return
  t.is(result.persistent.lower, result.persistent.upper)
  t.is(result.persistent.lower, 32 * 8 * 256 * 4096 * F16)
})

test('estimateLlm: context above the trained window is clamped', (t) => {
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0, ggufFacts: denseFacts({ contextLength: 2048 }) }),
    workload: { kind: 'llm', contextTokens: 1_000_000 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return
  t.is(result.persistent.lower, 32 * 8 * 256 * 2048 * F16, 'sized for 2048, not 1,000,000')
  t.ok(result.assumptions.some((a) => a.includes('clamped to the trained context')))
})

test('estimateLlm: per-layer classes cap windowed blocks at the sliding window', (t) => {
  // The real gemma-4-31B shape: 50 windowed blocks (16 KV heads, 256-wide) and
  // 10 full-attention blocks (4 KV heads, 512-wide), 1024-token window.
  const facts = denseFacts({
    architecture: 'gemma4',
    blockCount: 60,
    headCount: 32,
    headCountKv: 16,
    keyLength: 512,
    valueLength: 512,
    embeddingLength: 5376,
    contextLength: 262144,
    slidingWindow: 1024,
    keyLengthSwa: 256,
    valueLengthSwa: 256,
    kvLayerClasses: [
      { count: 50, headCountKv: 16, keyLength: 256, valueLength: 256, windowed: true },
      { count: 10, headCountKv: 4, keyLength: 512, valueLength: 512, windowed: false }
    ]
  })

  const contextTokens = 32768
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0, ggufFacts: facts }),
    workload: { kind: 'llm', contextTokens },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return

  const windowed = 50 * 16 * (256 + 256) * 1024 * F16
  const full = 10 * 4 * (512 + 512) * contextTokens * F16
  t.is(result.persistent.lower, windowed + full)

  // What the per-layer sum buys: reading every block as the widest one is 18x
  // larger here, and worse still at the model's full 262144-token context.
  const flat = 60 * 16 * (512 + 512) * contextTokens * F16
  t.ok(flat / result.persistent.upper > 15, 'the flat maximum is more than 15x the per-layer sum')
})

test('estimateLlm: hybrid attention sizes only the full-attention blocks', (t) => {
  // The real Qwen3.5 shape: full attention every 4th block, SSM state elsewhere.
  const facts = denseFacts({
    architecture: 'qwen35',
    blockCount: 32,
    headCount: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    embeddingLength: 2560,
    contextLength: 262144,
    fullAttentionInterval: 4,
    ssmStateSize: 128,
    ssmConvKernel: 4,
    ssmInnerSize: 4096
  })

  const contextTokens = 8192
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0, ggufFacts: facts }),
    workload: { kind: 'llm', contextTokens },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return

  const perBlockPerToken = 4 * (256 + 256)
  const ssm = 24 * (4096 * 128 + 4096 * 4) * 4
  t.is(result.persistent.lower, 8 * perBlockPerToken * contextTokens * F16 + ssm)
  t.is(result.persistent.upper, 8 * perBlockPerToken * contextTokens * F16 + ssm)
  t.ok(result.assumptions.some((a) => a.includes('every 4 blocks')))

  const flat = 32 * perBlockPerToken * contextTokens * F16
  t.ok(result.persistent.upper < flat, 'hybrid accounting is below the flat all-blocks figure')
})

test('estimateLlm: a sliding window without a layer pattern gives a deliberately wide bound', (t) => {
  // The real gpt-oss shape: a window is declared, but which blocks use it lives
  // in the engine, not the file.
  const facts = denseFacts({
    architecture: 'gpt-oss',
    blockCount: 24,
    headCount: 64,
    headCountKv: 8,
    keyLength: 64,
    valueLength: 64,
    embeddingLength: 2880,
    contextLength: 131072,
    slidingWindow: 128
  })

  const contextTokens = 16384
  const result = estimateLlm({
    profile: profile({ artifactBytes: 0, ggufFacts: facts }),
    workload: { kind: 'llm', contextTokens },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return

  const perBlockPerToken = 8 * (64 + 64)
  t.is(result.persistent.lower, 24 * perBlockPerToken * 128 * F16, 'every block windowed')
  t.is(result.persistent.upper, 24 * perBlockPerToken * contextTokens * F16, 'every block full')
  t.ok(result.reasons.some((r) => r.includes('engine-owned')))
})

test('estimateLlm: weights use the artifact size as the floor', (t) => {
  const result = estimateLlm({
    profile: profile({ artifactBytes: 4_000_000_000 }),
    workload: { kind: 'llm', contextTokens: 1024 },
    extraArtifactBytes: 500_000_000,
    calibration: calibration({ weightUpperCoeff: 1.05 }),
    hasGpu: false
  })

  t.is(result.kind, 'estimate')
  if (result.kind !== 'estimate') return
  const kv = 32 * 8 * 256 * 1024 * F16
  t.is(result.persistent.lower, 4_500_000_000 + kv, 'model plus companions plus resident KV')
  t.is(result.persistent.upper, Math.ceil(4_500_000_000 * 1.05 + kv))
  t.ok(result.assumptions.some((a) => a.includes('file-backed and evictable')))
})

// A completion was long assumed to add nothing on top of the load, and the
// harness's own sampler was broken in a way that agreed. It is measured now, so
// it lands in `working`: released after the operation, which is what
// `sequential` counts once and `concurrent` counts per model.
test('estimateLlm: the measured working peak is a peak, not resident memory', (t) => {
  const withPeak = estimateLlm({
    profile: profile({ artifactBytes: 0 }),
    workload: { kind: 'llm', contextTokens: 512 },
    extraArtifactBytes: 0,
    calibration: calibration({ workingPeakBytes: { lower: 0, upper: 80 * MIB } }),
    hasGpu: false
  })
  const without = estimateLlm({
    profile: profile({ artifactBytes: 0 }),
    workload: { kind: 'llm', contextTokens: 512 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })

  t.is(withPeak.kind, 'estimate')
  t.is(without.kind, 'estimate')
  if (withPeak.kind !== 'estimate' || without.kind !== 'estimate') return

  t.is(withPeak.working.upper, 80 * MIB)
  t.is(withPeak.working.lower, 0)
  t.is(
    withPeak.persistent.upper,
    without.persistent.upper,
    'the peak is not also counted as resident'
  )
  t.is(without.working.upper, 0, 'a fixture measured before the peak was sampled contributes none')
})

test('estimateLlm: refuses without GGUF facts or on the wrong workload', (t) => {
  const noFacts = estimateLlm({
    profile: { schemaVersion: 1, engine: 'llamacpp-completion', artifactBytes: 1 },
    workload: { kind: 'llm', contextTokens: 1024 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })
  t.is(noFacts.kind, 'unknown')

  const wrongWorkload = estimateLlm({
    profile: profile(),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })
  t.is(wrongWorkload.kind, 'unknown')
})

// ---------------------------------------------------------------------------
// Whisper estimator
// ---------------------------------------------------------------------------

test('estimateWhisper: working memory scales from the 30 s calibration window', (t) => {
  const cal = calibration({
    fixedOverheadBytes: { lower: 10 * MIB, upper: 20 * MIB },
    audioWindowBytes: { lower: 60 * MIB, upper: 90 * MIB },
    audioStreamingBytes: { lower: 5 * MIB, upper: 8 * MIB }
  })

  const oneWindow = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription', artifactBytes: 77_700_000 }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0,
    calibration: cal,
    hasGpu: false
  })
  t.is(oneWindow.kind, 'estimate')
  if (oneWindow.kind !== 'estimate') return
  t.is(oneWindow.working.lower, 10 * MIB + 60 * MIB)
  t.is(oneWindow.working.upper, 20 * MIB + 90 * MIB)
  t.is(oneWindow.persistent.lower, 77_700_000)

  const halfStreaming = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription', artifactBytes: 77_700_000 }),
    workload: { kind: 'audio', windowMs: 15_000, streaming: true, batch: 2 },
    extraArtifactBytes: 0,
    calibration: cal,
    hasGpu: false
  })
  t.is(halfStreaming.kind, 'estimate')
  if (halfStreaming.kind !== 'estimate') return
  t.is(halfStreaming.working.lower, 10 * MIB + 60 * MIB * 0.5 * 2 + 5 * MIB)
  t.ok(halfStreaming.assumptions.some((a) => a.includes('streaming session')))
})

test('estimateWhisper: refuses a non-audio workload', (t) => {
  const result = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription' }),
    workload: { kind: 'llm', contextTokens: 1024 },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })
  t.is(result.kind, 'unknown')
})

test('estimateWhisper: unmeasured audio coefficients refuse rather than under-estimate', (t) => {
  // FLAT_CALIBRATION carries the harness's placeholder zeros: consuming them
  // would return an estimate whose entire audio working memory is zero.
  const unmeasured = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription' }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0,
    calibration: calibration(),
    hasGpu: false
  })
  t.is(unmeasured.kind, 'unknown')
  if (unmeasured.kind !== 'unknown') return
  t.ok(unmeasured.reasons.some((r) => r.includes('has not been measured')))

  // A measured window is not enough for a streaming session whose own
  // coefficient is still a placeholder.
  const windowOnly = calibration({ audioWindowBytes: { lower: 60 * MIB, upper: 90 * MIB } })
  const streaming = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription' }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: true },
    extraArtifactBytes: 0,
    calibration: windowOnly,
    hasGpu: false
  })
  t.is(streaming.kind, 'unknown')

  const oneShot = estimateWhisper({
    profile: profile({ engine: 'whispercpp-transcription' }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0,
    calibration: windowOnly,
    hasGpu: false
  })
  t.is(oneShot.kind, 'estimate', 'a measured window supports a non-streaming estimate')
})

// ---------------------------------------------------------------------------
// Budget and reserve
// ---------------------------------------------------------------------------

test('assess: desktop reserve is 20% of available, capped at 2 GiB', (t) => {
  const small = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(small.budget?.availableBytes, 5 * GIB)
  t.is(small.budget?.reservedBytes, 1 * GIB, '20% of the 5 GiB available')
  t.is(small.budget?.availableAfterReserveBytes, 4 * GIB)

  const large = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(large.budget?.reservedBytes, 2 * GIB, 'the cap holds once 20% of available passes it')
  t.is(large.budget?.availableAfterReserveBytes, 46 * GIB)
})

// The reserve used to be a share of total subtracted from available, so on a
// host already using most of its RAM it exceeded the headroom and zeroed the
// budget — every model, however small, read likely-too-large.
test('assess: a busy host keeps a budget proportional to what is free', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate({ workload: { kind: 'llm', contextTokens: 1 } })],
    execution: 'sequential',
    resources: resources({ totalBytes: 24 * GIB, usedBytes: 20.7 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile({ artifactBytes: 2 * GIB })
  })
  const available = 24 * GIB - 20.7 * GIB
  const reserved = Math.floor(available * 0.2)
  t.is(result.budget?.availableBytes, available)
  t.is(result.budget?.reservedBytes, reserved)
  t.is(result.budget?.availableAfterReserveBytes, available - reserved)
  t.is(result.verdict, 'likely-fits', 'a 2 GiB model fits in 3.3 GiB of free memory')
})

test('assess: iOS budgets are per-process and refuse without the allowance metric', (t) => {
  // System metrics being supported must NOT produce a budget on iOS: jetsam
  // enforces a per-process limit, and a system budget would defend verdicts
  // the OS does not honor.
  const withoutMetric = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB }),
    platform: 'ios-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(withoutMetric.basis, 'process-memory')
  t.is(withoutMetric.verdict, 'unknown')
  t.absent(withoutMetric.budget)
  t.ok(
    withoutMetric.reasons.some((r) => r.includes('per-process allowance metric is not available'))
  )

  const withMetric = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ processUsedBytes: 1 * GIB, processAvailableBytes: 2.5 * GIB }),
    platform: 'ios-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(withMetric.basis, 'process-memory')
  // Ceiling = allowance + footprint (the relation jetsam enforces); the mobile
  // reserve is taken from the allowance: min(1 GiB, 20% of 2.5 GiB) = 0.5 GiB.
  t.is(withMetric.budget?.totalBytes, 3.5 * GIB)
  t.is(withMetric.budget?.usedBytes, 1 * GIB)
  t.is(withMetric.budget?.availableBytes, 2.5 * GIB)
  t.is(withMetric.budget?.reservedBytes, 0.5 * GIB)
  t.is(withMetric.budget?.availableAfterReserveBytes, 2 * GIB)
})

test('assess: android keeps the system basis with the mobile reserve, by explicit decision', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB }),
    platform: 'android-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(result.basis, 'system-memory')
  t.is(result.budget?.reservedBytes, 1 * GIB, '20% of the 6 GiB available, capped at 1 GiB')
  t.ok(result.assumptions.some((a) => a.includes('android budgets deliberately use system memory')))
})

test('assess: unusable or inconsistent memory evidence yields unknown', (t) => {
  const base = resources()

  const noSample = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: { capabilities: base.capabilities },
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(noSample.verdict, 'unknown')
  t.absent(noSample.budget)
  t.ok(noSample.reasons.some((r) => r.includes('no memory sample')))

  const unsupported = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: {
      capabilities: base.capabilities,
      sample: {
        sampledAt: 0,
        cpu: { status: 'unavailable' },
        memory: {
          usedBytes: { status: 'unavailable' },
          totalBytes: { status: 'unavailable' },
          processUsedBytes: { status: 'unavailable' },
          processAvailableBytes: { status: 'unavailable' }
        },
        gpus: { status: 'unavailable' }
      }
    },
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(unsupported.verdict, 'unknown')
  t.ok(unsupported.reasons.some((r) => r.includes('not supported')))

  const inconsistent = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 9 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(inconsistent.verdict, 'unknown')
  t.ok(inconsistent.reasons.some((r) => r.includes('inconsistent')))
})

// ---------------------------------------------------------------------------
// Verdict boundaries
// ---------------------------------------------------------------------------

test('assess: verdict boundaries around the budget', (t) => {
  // Budget: 8 GiB total, 3 GiB used => 5 GiB available, 1 GiB reserved => 4 GiB.
  function verdictFor(artifactBytes: number, weightUpperCoeff: number) {
    return assessModelFitFromResources({
      models: [candidate({ workload: { kind: 'llm', contextTokens: 1 } })],
      execution: 'sequential',
      resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
      platform: 'darwin-arm64',
      calibration: calibration({ weightUpperCoeff }),
      resolveProfile: () =>
        profile({ artifactBytes, ggufFacts: denseFacts({ blockCount: 1, headCountKv: 1 }) })
    })
  }

  // 1 block × 1 KV head × 256 elements × 1 token × 2 bytes = 512 bytes of KV.
  const exactlyAtBudget = verdictFor(4 * GIB - 512, 1)
  t.is(exactlyAtBudget.verdict, 'likely-fits', 'upper bound exactly equal to the budget fits')

  const justOver = verdictFor(4 * GIB - 511, 1)
  t.is(justOver.verdict, 'likely-too-large', 'lower bound one byte over the budget does not')

  const straddling = verdictFor(3.9 * GIB, 1.1)
  t.is(straddling.verdict, 'unknown', 'a bound that straddles the budget cannot be called')
  t.ok(straddling.estimate!.lowerBoundBytes <= 4 * GIB)
  t.ok(straddling.estimate!.upperBoundBytes > 4 * GIB)
})

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('assess: sequential takes the largest working peak, concurrent sums them', (t) => {
  // Audio working memory is the per-operation peak that distinguishes the two
  // modes — an LLM load holds everything resident, so it cannot.
  const cal = calibration({ audioWindowBytes: { lower: 60 * MIB, upper: 60 * MIB } })

  const models: ModelFitCandidate[] = [
    candidate({
      model: { name: 'A', sha256Checksum: 'a'.repeat(64) },
      workload: { kind: 'audio', windowMs: 30_000, streaming: false }
    }),
    candidate({
      model: { name: 'B', sha256Checksum: 'b'.repeat(64) },
      workload: { kind: 'audio', windowMs: 60_000, streaming: false }
    })
  ]

  const resolveProfile = () =>
    profile({ engine: 'whispercpp-transcription', artifactBytes: 1 * GIB, ggufFacts: undefined })

  const sequential = assessModelFitFromResources({
    models,
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: cal,
    resolveProfile
  })
  const concurrent = assessModelFitFromResources({
    models,
    execution: 'concurrent',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: cal,
    resolveProfile
  })

  // Both keep 2 × 1 GiB of weights resident; the peaks are one window (60 MiB)
  // for A and two windows (120 MiB) for B.
  const persistent = 2 * GIB
  t.is(sequential.estimate?.lowerBoundBytes, persistent + 120 * MIB)
  t.is(concurrent.estimate?.lowerBoundBytes, persistent + 180 * MIB)
  t.is(sequential.execution, 'sequential')
  t.is(concurrent.execution, 'concurrent')
})

test('assess: co-resident LLM loads count every model’s overhead, so the modes agree', (t) => {
  const cal = calibration({ fixedOverheadBytes: { lower: 1 * GIB, upper: 1 * GIB } })
  const facts = denseFacts({ blockCount: 1, headCountKv: 1, contextLength: 8192 })

  const models: ModelFitCandidate[] = [
    candidate({
      model: { name: 'A', sha256Checksum: 'a'.repeat(64) },
      workload: { kind: 'llm', contextTokens: 1 }
    }),
    candidate({
      model: { name: 'B', sha256Checksum: 'b'.repeat(64) },
      workload: { kind: 'llm', contextTokens: 1 }
    })
  ]

  const resolveProfile = () => profile({ artifactBytes: 2 * GIB, ggufFacts: facts })

  const sequential = assessModelFitFromResources({
    models,
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: cal,
    resolveProfile
  })
  const concurrent = assessModelFitFromResources({
    models,
    execution: 'concurrent',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: cal,
    resolveProfile
  })

  // Each resident model carries its weights, 512 B KV cache and 1 GiB overhead
  // under either mode: `sequential` must not drop the second model's. Only the
  // working peak separates the modes, and this fixture carries none.
  const total = 2 * (2 * GIB + 512 + 1 * GIB)
  t.is(sequential.estimate?.lowerBoundBytes, total)
  t.is(concurrent.estimate?.lowerBoundBytes, total)

  // With a measured peak, only the operation in flight pays for it under
  // `sequential`, while `concurrent` assumes one per model.
  const withPeak = (execution: 'sequential' | 'concurrent') =>
    assessModelFitFromResources({
      models,
      execution,
      resources: resources(),
      platform: 'darwin-arm64',
      calibration: calibration({
        fixedOverheadBytes: { lower: 1 * GIB, upper: 1 * GIB },
        workingPeakBytes: { lower: 80 * MIB, upper: 80 * MIB }
      }),
      resolveProfile
    })
  t.is(withPeak('sequential').estimate?.lowerBoundBytes, total + 80 * MIB)
  t.is(withPeak('concurrent').estimate?.lowerBoundBytes, total + 160 * MIB)
})

// ---------------------------------------------------------------------------
// Unknown propagation
// ---------------------------------------------------------------------------

test('assess: one unknown model makes the combined verdict unknown', (t) => {
  const known = candidate({
    model: { name: 'KNOWN', sha256Checksum: 'a'.repeat(64) }
  })
  const unknown = candidate({
    model: { name: 'UNKNOWN', sha256Checksum: 'b'.repeat(64) }
  })

  const result = assessModelFitFromResources({
    models: [known, unknown],
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: (checksum) => (checksum === 'a'.repeat(64) ? profile() : undefined)
  })

  t.is(result.verdict, 'unknown')
  t.absent(result.estimate, 'no combined estimate when one model is unknown')
  t.is(result.models[0]!.verdict, 'likely-fits', 'the known model still reports its own verdict')
  t.is(result.models[1]!.verdict, 'unknown')
  t.ok(result.models[1]!.reasons.some((r) => r.includes('no resource profile')))
})

test('assess: an uncalibrated platform yields unknown for every model', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: 'linux-arm64',
    calibration: undefined,
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.budget, 'the budget is still reported — only the estimate is missing')
  t.ok(result.reasons.some((r) => r.includes('no validated calibration')))
  t.is(result.models[0]!.verdict, 'unknown')
  t.ok(
    result.models[0]!.reasons.some((r) => r.includes('no validated calibration for linux-arm64')),
    'the per-model reason names the uncalibrated platform'
  )
})

test('assess: an unrecognized platform yields unknown', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: undefined,
    calibration: undefined,
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.reasons.some((r) => r.includes('not one this assessment covers')))
  t.is(result.models[0]!.verdict, 'unknown')
  t.ok(
    result.models[0]!.reasons.some((r) => r.includes('not one this assessment covers')),
    'the per-model reason states the platform is uncovered, not that calibration is missing'
  )
})

test('assess: an engine with no estimator yields unknown', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile({ engine: 'nmtcpp-translation', ggufFacts: undefined })
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.models[0]!.reasons.some((r) => r.includes('no estimator in this phase')))
})

test('assess: a companion artifact missing from the catalog yields unknown', (t) => {
  const result = assessModelFitFromResources({
    models: [
      candidate({
        artifacts: [{ name: 'VAD', sha256Checksum: 'c'.repeat(64) }]
      })
    ],
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: (checksum) => (checksum === 'a'.repeat(64) ? profile() : undefined)
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.models[0]!.reasons.some((r) => r.includes('`artifacts`')))
})

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

test('assess: the result always states its basis and its assumptions', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ gpu: true }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'system-memory')
  t.ok(
    result.assumptions.some((a) => a.includes('does not schedule, serialize, or reserve')),
    'the execution mode is declared as an assumption, not a scheduling promise'
  )
  t.ok(result.assumptions.some((a) => a.includes('advisory')))
  t.ok(
    result.assumptions.some((a) => a.includes('cache-type-k')),
    'default KV-cache types are called out'
  )
  t.is(result.models[0]!.estimatorVersion, LLM_ESTIMATOR_VERSION)
})

// ---------------------------------------------------------------------------
// Calibration fit
// ---------------------------------------------------------------------------

/** Points generated from known coefficients, one per (artifact, context) pair. */
function syntheticPoints(
  weightRatio: number,
  fixedBytes: number,
  perTokenBytes: number
): CalibrationPoint[] {
  const artifacts = [500 * MIB, 1 * GIB, 4 * GIB]
  const contexts = [512, 8192]
  const points: CalibrationPoint[] = []
  for (const artifactBytes of artifacts) {
    for (const contextTokens of contexts) {
      const kvBytes = contextTokens * 1024
      points.push({
        artifactBytes,
        contextTokens,
        kvBytes,
        persistentBytes:
          weightRatio * artifactBytes + perTokenBytes * contextTokens + fixedBytes + kvBytes
      })
    }
  }
  return points
}

/** Every observed point must sit at or below the fitted plane plus its excess. */
function coversEveryPoint(
  t: { ok(value: unknown, message?: string): void },
  points: readonly CalibrationPoint[],
  fit: NonNullable<ReturnType<typeof fitResidentMemory>>
) {
  for (const point of points) {
    const covered =
      fit.weightRatio * point.artifactBytes +
      fit.perTokenBytes * point.contextTokens +
      fit.fixedBytes +
      fit.worstExcessBytes +
      point.kvBytes
    t.ok(point.persistentBytes <= covered + 1e-6, 'the fit plus its excess covers every point')
  }
}

test('fitResidentMemory: recovers exact coefficients from noiseless points', (t) => {
  const points = syntheticPoints(1.05, 256 * MIB, 20_000)
  const fit = fitResidentMemory(points)

  t.ok(fit, 'six points over three artifacts and two contexts determine the plane')
  if (!fit) return
  t.ok(Math.abs(fit.weightRatio - 1.05) < 1e-6)
  t.ok(Math.abs(fit.fixedBytes - 256 * MIB) < 1)
  t.ok(Math.abs(fit.perTokenBytes - 20_000) < 1e-3)
  t.ok(fit.worstExcessBytes < 1, 'a perfect fit leaves no excess')
})

test('fitResidentMemory: an outlier above the plane lands in the excess, never below the bound', (t) => {
  const points = syntheticPoints(1.05, 256 * MIB, 20_000)
  points[3] = { ...points[3]!, persistentBytes: points[3]!.persistentBytes + 200 * MIB }

  const fit = fitResidentMemory(points)
  t.ok(fit)
  if (!fit) return
  t.ok(fit.worstExcessBytes > 0, 'the outlier is not absorbed silently')
  coversEveryPoint(t, points, fit)
})

test('fitResidentMemory: a negative solution clamps to zero and still covers the points', (t) => {
  // No per-token cost at all, with noise nudging the slope slightly negative.
  const points = syntheticPoints(1.0, 128 * MIB, 0)
  points[1] = { ...points[1]!, persistentBytes: points[1]!.persistentBytes - 5 * MIB }

  const fit = fitResidentMemory(points)
  t.ok(fit)
  if (!fit) return
  t.ok(fit.perTokenBytes >= 0)
  t.ok(fit.fixedBytes >= 0)
  coversEveryPoint(t, points, fit)
})

test('fitResidentMemory: refuses designs that cannot separate the coefficients', (t) => {
  t.is(fitResidentMemory([]), undefined, 'no points')
  t.is(fitResidentMemory(syntheticPoints(1.05, 0, 0).slice(0, 2)), undefined, 'two points')

  // A single context makes the per-token column indistinguishable from the
  // intercept, so the normal matrix is singular.
  const singleContext = syntheticPoints(1.05, 256 * MIB, 20_000).filter(
    (p) => p.contextTokens === 512
  )
  t.is(fitResidentMemory(singleContext), undefined, 'one context throughout')
})

test('kvObservation: a counter that sees every allocation scores 1; compute buffers push it above', (t) => {
  const exact = kvObservation(syntheticPoints(1.0, 128 * MIB, 0))
  t.is(exact.models.length, 3, 'one growth per model')
  t.ok(Math.abs(exact.ratio - 1) < 1e-9, 'persistent grows by exactly the KV growth')

  const withCompute = kvObservation(syntheticPoints(1.0, 128 * MIB, 20_000))
  t.ok(withCompute.ratio > 1, 'per-token compute buffers only add to the growth')
})

test('kvObservation: a counter that misses allocation scores its shortfall', (t) => {
  // Persistent carries 56% of the KV growth — what the win32 working set measured.
  const points = syntheticPoints(1.0, 128 * MIB, 0).map((p) => ({
    ...p,
    persistentBytes: p.persistentBytes - 0.44 * p.kvBytes
  }))
  const observation = kvObservation(points)
  t.ok(Math.abs(observation.ratio - 0.56) < 1e-6)
  for (const model of observation.models) {
    t.ok(model.observedDeltaBytes < model.kvDeltaBytes, 'every model shows the shortfall')
  }
})

test('kvObservation: one cold-start repeat does not read as a shortfall, and a single context has nothing to judge', (t) => {
  const base = syntheticPoints(1.0, 128 * MIB, 0)
  // Three repeats per point; the very first load of the run carries a cold
  // page-cache transient (~250 MiB observed) on the small context only. The
  // median of the repeats ignores it, where a mean would read a 15% shortfall.
  const repeated = [...base, ...base, ...base]
  const first = repeated.findIndex((p) => p.contextTokens === 512)
  repeated[first] = {
    ...repeated[first]!,
    persistentBytes: repeated[first]!.persistentBytes + 250 * MIB
  }
  t.ok(Math.abs(kvObservation(repeated).ratio - 1) < 1e-9)

  const single = kvObservation(base.filter((p) => p.contextTokens === 512))
  t.is(single.models.length, 0)
  t.is(single.ratio, 1)
})

// ---------------------------------------------------------------------------
// Discrete-GPU platforms
// ---------------------------------------------------------------------------

test('assess: a GPU on linux or windows needs coefficients measured on it', (t) => {
  // These platforms' fixtures describe CPU-resident execution, measured with
  // the GPU offload disabled. With a GPU present the engine would not run that
  // way, so those coefficients do not describe the load — whether the card
  // holds the model in its own memory or, as here, shares system RAM.
  const withGpu = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ gpu: true }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(withGpu.verdict, 'unknown')
  t.is(withGpu.models[0]!.verdict, 'unknown')
  t.ok(withGpu.models[0]!.reasons.some((r) => r.includes('a GPU is present')))

  const cpuOnly = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.ok(cpuOnly.models[0]!.estimate, 'without a GPU the CPU-resident fixture applies')

  const appleSilicon = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ gpu: true }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.ok(appleSilicon.models[0]!.estimate, 'unified-memory platforms keep verdicts with a GPU')
})

/** A second (or third) card on the same host, as `extraGpus` describes it. */
interface ExtraGpu {
  vramTotalBytes: number
  vramUsedBytes: number
  /** `vulkan` unless stated; a different backend makes the pair unassessable. */
  backend?: 'vulkan' | 'rocm'
  /** Declared memory, when it differs from the sampled total (Windows iGPU). */
  declaredBytes?: number
  unifiedMemory?: boolean
  name?: string
}

// A discrete card whose sampled memory the collector graded device-scoped.
function discreteGpuResources(options: {
  vramTotalBytes: number
  vramUsedBytes: number
  systemTotalBytes?: number
  systemUsedBytes?: number
  gpuScope?: 'device' | 'budget'
  extraGpus?: readonly ExtraGpu[]
}) {
  const provenance = { source: 'test', scope: options.gpuScope ?? ('device' as const) }
  const system = { source: 'test', scope: 'system' as const }
  const total = options.systemTotalBytes ?? 64 * GIB
  const used = options.systemUsedBytes ?? 16 * GIB
  const supported = (value: number, p: typeof provenance | typeof system) =>
    ({ status: 'supported', value, provenance: p }) as const

  const value: SystemResources = {
    capabilities: {
      cpu: { status: 'unavailable' },
      memory: { totalBytes: supported(total, system) },
      gpus: {
        status: 'supported',
        provenance: system,
        value: [
          {
            id: 'gpu0',
            name: { status: 'supported', value: 'Test Discrete GPU', provenance },
            vendor: { status: 'unavailable' },
            type: { status: 'unavailable' },
            driverName: { status: 'unavailable' },
            driverVersion: { status: 'unavailable' },
            drivers: {
              vulkan: { status: 'supported', value: true, provenance },
              opencl: { status: 'unavailable' },
              opengl: { status: 'unavailable' },
              webgpu: { status: 'unavailable' },
              metal: { status: 'unavailable' },
              direct3d11: { status: 'unavailable' },
              direct3d12: { status: 'unavailable' },
              cuda: { status: 'unavailable' },
              levelZero: { status: 'unavailable' },
              rocm: { status: 'unavailable' }
            },
            unifiedMemory: { status: 'supported', value: false, provenance },
            memoryTotalBytes: supported(options.vramTotalBytes, provenance)
          },
          ...(options.extraGpus ?? []).map((extra, index) => ({
            id: `gpu${index + 1}`,
            name: {
              status: 'supported' as const,
              value: extra.name ?? 'Second GPU',
              provenance
            },
            vendor: { status: 'unavailable' as const },
            type: { status: 'unavailable' as const },
            driverName: { status: 'unavailable' as const },
            driverVersion: { status: 'unavailable' as const },
            drivers: {
              vulkan:
                (extra.backend ?? 'vulkan') === 'vulkan'
                  ? ({ status: 'supported' as const, value: true, provenance } as const)
                  : ({ status: 'unavailable' as const } as const),
              opencl: { status: 'unavailable' as const },
              opengl: { status: 'unavailable' as const },
              webgpu: { status: 'unavailable' as const },
              metal: { status: 'unavailable' as const },
              direct3d11: { status: 'unavailable' as const },
              direct3d12: { status: 'unavailable' as const },
              cuda: { status: 'unavailable' as const },
              levelZero: { status: 'unavailable' as const },
              rocm:
                extra.backend === 'rocm'
                  ? ({ status: 'supported' as const, value: true, provenance } as const)
                  : ({ status: 'unavailable' as const } as const)
            },
            unifiedMemory: {
              status: 'supported' as const,
              value: extra.unifiedMemory ?? false,
              provenance
            },
            memoryTotalBytes: supported(extra.declaredBytes ?? extra.vramTotalBytes, provenance)
          }))
        ]
      }
    },
    sample: {
      sampledAt: 0,
      cpu: { status: 'unavailable' },
      memory: {
        usedBytes: supported(used, system),
        totalBytes: supported(total, system),
        processUsedBytes: { status: 'unavailable' },
        processAvailableBytes: { status: 'unavailable' }
      },
      gpus: {
        status: 'supported',
        provenance: system,
        value: [
          {
            id: 'gpu0',
            compute: { status: 'unavailable' },
            encode: { status: 'unavailable' },
            decode: { status: 'unavailable' },
            memoryUsedBytes: supported(options.vramUsedBytes, provenance),
            memoryTotalBytes: supported(options.vramTotalBytes, provenance),
            powerWatts: { status: 'unavailable' },
            temperatureCelsius: { status: 'unavailable' }
          },
          ...(options.extraGpus ?? []).map((extra, index) => ({
            id: `gpu${index + 1}`,
            compute: { status: 'unavailable' as const },
            encode: { status: 'unavailable' as const },
            decode: { status: 'unavailable' as const },
            memoryUsedBytes: supported(extra.vramUsedBytes, provenance),
            memoryTotalBytes: supported(extra.vramTotalBytes, provenance),
            powerWatts: { status: 'unavailable' as const },
            temperatureCelsius: { status: 'unavailable' as const }
          }))
        ]
      }
    }
  }
  return value
}

test('assess: a calibrated discrete GPU is budgeted against its own memory', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'device-memory')
  t.is(result.budget?.totalBytes, 20 * GIB)
  t.is(result.budget?.usedBytes, 1 * GIB)
  t.ok(result.models[0]!.estimate, 'a calibrated backend produces an estimate, not unknown')
  t.ok(result.assumptions.some((a) => a.includes('vulkan')))
})

test('assess: an uncalibrated backend stays unknown on a discrete GPU', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => undefined,
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.is(result.basis, 'system-memory')
  t.ok(result.models[0]!.reasons.some((r) => r.includes('a GPU is present')))
})

test('assess: a GPU with too little VRAM is too large even on a roomy host', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 2 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'likely-too-large')
})

// The engine pins the model to one card, and which one is a ggml enumeration
// order this side cannot see. That makes the cards alternatives rather than
// bounds to intersect: a fit has to hold on the smallest, a refusal on the
// largest, and anything between the two is genuinely unknown.
test('assess: several GPUs are assessed as alternatives, not as one budget', (t) => {
  const assess = (options: Parameters<typeof discreteGpuResources>[0]) =>
    assessModelFitFromResources({
      models: [candidate()],
      execution: 'sequential',
      resources: discreteGpuResources(options),
      platform: 'linux-x64',
      calibration: calibration(),
      resolveGpuCalibration: () => calibration(),
      resolveProfile: () => profile()
    })

  const twoRoomy = assess({
    vramTotalBytes: 20 * GIB,
    vramUsedBytes: 1 * GIB,
    extraGpus: [{ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }]
  })
  t.is(twoRoomy.verdict, 'likely-fits', 'it fits on either card, so which one is picked is moot')
  t.is(twoRoomy.basis, 'device-memory')
  t.ok(twoRoomy.assumptions.some((a) => a.includes('2 usable GPUs')))

  // 1 GB of weights plus the cache: room on the 20 GiB card, none on the 2 GiB
  // one. Neither answer holds for both, so there is no verdict.
  const mixed = assess({
    vramTotalBytes: 20 * GIB,
    vramUsedBytes: 1 * GIB,
    extraGpus: [{ vramTotalBytes: 2 * GIB, vramUsedBytes: 1 * GIB }]
  })
  t.is(mixed.verdict, 'unknown', 'a fit on the larger card is not a fit on the smaller')
  t.is(mixed.budget?.totalBytes, 2 * GIB, 'the budget reported is the tightest of the candidates')

  const bothTooSmall = assess({
    vramTotalBytes: 2 * GIB,
    vramUsedBytes: 1 * GIB,
    extraGpus: [{ vramTotalBytes: 2 * GIB, vramUsedBytes: 1.5 * GIB }]
  })
  t.is(bothTooSmall.verdict, 'likely-too-large', 'too large on the largest is too large anywhere')
})

// One fixture describes one backend's buffers, so cards that disagree on the
// backend cannot be assessed under a single set of coefficients.
test('assess: GPUs on different backends have no single set of coefficients', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      extraGpus: [{ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB, backend: 'rocm' }]
    }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.is(result.basis, 'system-memory')
})

// The Windows shape: the Intel iGPU declares a 128 MiB carve-out of its own,
// so DXGI types it dedicated and `unifiedMemory` is false. Nothing but that
// size separates it from a real card — and it is no rival for a model.
test('assess: an adapter too small to hold a model is not a rival for one', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      extraGpus: [
        {
          vramTotalBytes: 128 * MIB,
          vramUsedBytes: 8 * MIB,
          name: 'Intel(R) UHD Graphics'
        }
      ]
    }),
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.budget?.totalBytes, 20 * GIB, 'the real card carries the budget on its own')
  t.ok(result.assumptions.some((a) => a.includes('Test Discrete GPU')))
})

// A VM's paravirtual display adapter is enumerated as a GPU by the collector,
// but the engine has no backend for it and runs on the CPU — which is exactly
// what these platforms' own coefficients describe. Cloud hosts and CI runners
// are the common case, so this is where the CPU fixtures earn their keep.
test('assess: a virtual display adapter is not a GPU the engine can use', (t) => {
  const withVirtualGpu = resources({ gpu: true })
  const gpus = withVirtualGpu.capabilities.gpus
  if (gpus.status === 'supported') {
    const provenance = { source: 'test', scope: 'device' as const }
    gpus.value[0] = {
      ...gpus.value[0]!,
      name: { status: 'supported', value: 'Microsoft Basic Render Driver', provenance },
      // gpuType.VIRTUAL
      type: { status: 'supported', value: 3, provenance }
    }
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: withVirtualGpu,
    platform: 'linux-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'system-memory')
  t.is(result.verdict, 'likely-fits', 'the platform fixture applies, as it would with no GPU')
  t.ok(
    result.assumptions.some((a) => a.includes('no GPU reported')),
    'and the f16 KV default is assumed, as the engine would use'
  )
})

// The driver flags are library-presence checks, and ggml's backends need the
// same libraries to load. A device with none is a device the engine passes over.
test('assess: a GPU with no graphics API the engine talks to is passed over', (t) => {
  const noDrivers = resources({ gpu: true })
  const gpus = noDrivers.capabilities.gpus
  if (gpus.status === 'supported') {
    gpus.value[0] = {
      ...gpus.value[0]!,
      drivers: { ...gpus.value[0]!.drivers, metal: { status: 'unavailable' } }
    }
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: noDrivers,
    platform: 'linux-x64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'likely-fits')
})

// An AMD APU under amdgpu exposes a VRAM carve-out, so libgpuinfo infers
// `dedicated` from sysfs and `unifiedMemory` reads false — a Ryzen 5000U
// laptop reported over a gigabyte of "VRAM". Applying the discrete card's
// fixture and budgeting against the carve-out would be wrong twice over.
test('assess: an AMD GPU on linux cannot be placed, so it stays unknown', (t) => {
  const resources = discreteGpuResources({ vramTotalBytes: 2 * GIB, vramUsedBytes: 256 * MIB })
  const gpus = resources.capabilities.gpus
  if (gpus.status === 'supported') {
    const provenance = { source: 'test', scope: 'device' as const }
    gpus.value[0] = {
      ...gpus.value[0]!,
      name: { status: 'supported', value: 'Lucienne', provenance },
      driverName: { status: 'supported', value: 'amdgpu', provenance }
    }
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources,
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveSharedGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.is(result.basis, 'system-memory', 'and no device budget is formed from the carve-out')
  t.ok(result.reasons.some((r) => r.includes('cannot say where the model would execute')))

  // The same card on windows is unambiguous: DXGI reports real dedicated VRAM.
  const onWindows = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })
  t.is(onWindows.verdict, 'likely-fits')
})

// ---------------------------------------------------------------------------
// Integrated GPUs — the ordinary consumer desktop
// ---------------------------------------------------------------------------

// An integrated GPU allocates out of system RAM, so the engine runs on the GPU
// while the system basis still bounds it. That needs coefficients measured
// that way: the platform's own fixture was measured with the offload disabled.
test('assess: an integrated GPU keeps the system basis, with its own coefficients', (t) => {
  const igpuOnly = {
    models: [candidate()],
    execution: 'sequential' as const,
    resources: resources({ gpu: true }),
    platform: 'linux-x64' as const,
    calibration: calibration(),
    resolveProfile: () => profile()
  }

  const measured = assessModelFitFromResources({
    ...igpuOnly,
    resolveSharedGpuCalibration: () => calibration()
  })
  t.is(measured.basis, 'system-memory')
  t.is(measured.verdict, 'likely-fits')
  t.ok(measured.assumptions.some((a) => a.includes('integrated GPU allocates out of system RAM')))

  const unmeasured = assessModelFitFromResources({
    ...igpuOnly,
    resolveSharedGpuCalibration: () => undefined
  })
  t.is(unmeasured.verdict, 'unknown')
  t.ok(
    unmeasured.reasons.some((r) => r.includes('integrated metal GPU')),
    'the refusal names the platform and backend whose fixture is missing'
  )
})

// The host `win32-x64:vulkan-shared` exists for: an ordinary Windows laptop
// whose only GPU is the Intel iGPU. DXGI types it dedicated for a 128 MiB
// carve-out and `unifiedMemory` reads false, so the size floor is the only
// thing that identifies it — and with no discrete card beside it, nothing else
// can carry the budget.
test('assess: a Windows laptop with only an iGPU takes the shared fixture', (t) => {
  const igpuOnly = discreteGpuResources({
    vramTotalBytes: 128 * MIB,
    vramUsedBytes: 8 * MIB,
    gpuScope: 'budget',
    systemTotalBytes: 32 * GIB,
    systemUsedBytes: 8 * GIB
  })
  const gpus = igpuOnly.capabilities.gpus
  if (gpus.status === 'supported') {
    const provenance = { source: 'test', scope: 'device' as const }
    gpus.value[0] = {
      ...gpus.value[0]!,
      name: { status: 'supported', value: 'Intel(R) UHD Graphics 770', provenance }
    }
  }

  const measured = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: igpuOnly,
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveSharedGpuCalibration: () => calibration({ weightUpperCoeff: 2.044 }),
    resolveProfile: () => profile()
  })

  t.is(measured.basis, 'system-memory', 'not the 128 MiB carve-out')
  t.is(measured.budget?.totalBytes, 32 * GIB)
  t.is(measured.verdict, 'likely-fits')
  t.ok(measured.assumptions.some((a) => a.includes('Intel(R) UHD Graphics 770')))

  // Without the shared fixture it must not fall back to the CPU coefficients.
  const unmeasured = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: igpuOnly,
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveSharedGpuCalibration: () => undefined,
    resolveProfile: () => profile()
  })
  t.is(unmeasured.verdict, 'unknown')
  t.ok(unmeasured.reasons.some((r) => r.includes('integrated vulkan GPU')))
})

// A dedicated card next to the integrated one is where the engine would put
// the model: `chooseBackend` fills its GPU list before its iGPU list and takes
// the first non-empty one.
test('assess: a dedicated card beside an integrated one takes the device basis', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      extraGpus: [
        {
          vramTotalBytes: 16 * GIB,
          vramUsedBytes: 2 * GIB,
          unifiedMemory: true,
          name: 'Integrated Graphics'
        }
      ]
    }),
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveSharedGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'device-memory')
  t.is(result.budget?.totalBytes, 20 * GIB)
  t.ok(result.assumptions.some((a) => a.includes('Test Discrete GPU')))
})

// Windows GPU readings are per-process, so the collector never grades them
// device-scoped and no GPU budget can form.
test('assess: unverified GPU samples cannot form a device budget', (t) => {
  const resources = discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB })
  const samples = resources.sample!.gpus
  if (samples.status === 'supported') {
    samples.value[0]!.memoryTotalBytes = { status: 'unverified' }
    samples.value[0]!.memoryUsedBytes = { status: 'unverified' }
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources,
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.is(result.basis, 'system-memory')
})

// DXGI gives a per-process budget, not the device's memory. It still answers
// the question admission asks — what may this process allocate — so it gets
// its own basis rather than being discarded.
test('assess: windows budgets against the GPU allowance it is granted', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      gpuScope: 'budget'
    }),
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'device-budget')
  t.is(result.verdict, 'likely-fits')
  t.ok(result.models[0]!.estimate)
})

// The bound that a GPU load also costs system RAM has to reach the per-model
// verdicts, not just the combined one, or the two contradict each other.
test('assess: the system bound reaches per-model verdicts as well as the combined one', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      systemTotalBytes: 8 * GIB,
      systemUsedBytes: 7 * GIB,
      gpuScope: 'budget'
    }),
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'likely-too-large', 'plenty of VRAM, no system RAM')
  t.is(result.models[0]!.verdict, 'likely-too-large', 'and the model agrees with the whole')
  t.ok(result.reasons.some((r) => r.includes('system RAM')))
})

// Windows classifies the Intel iGPU as dedicated because it declares 128 MiB
// of its own, so the count alone would refuse a host with one real card.
test('assess: an adapter too small to hold a model is not a rival candidate', (t) => {
  const resources = discreteGpuResources({
    vramTotalBytes: 20 * GIB,
    vramUsedBytes: 1 * GIB,
    gpuScope: 'budget'
  })
  const gpus = resources.capabilities.gpus
  const samples = resources.sample!.gpus
  if (gpus.status === 'supported' && samples.status === 'supported') {
    gpus.value.push({
      ...gpus.value[0]!,
      id: 'igpu',
      memoryTotalBytes: {
        status: 'supported',
        value: 128 * 1024 * 1024,
        provenance: { source: 'test', scope: 'device' }
      }
    })
    samples.value.push({
      ...samples.value[0]!,
      id: 'igpu',
      memoryTotalBytes: {
        status: 'supported',
        value: 128 * 1024 * 1024,
        provenance: { source: 'test', scope: 'budget' }
      },
      memoryUsedBytes: {
        status: 'supported',
        value: 0,
        provenance: { source: 'test', scope: 'budget' }
      }
    })
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources,
    platform: 'win32-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'device-budget', 'the real card still resolves')
  t.is(result.budget?.totalBytes, 20 * GIB)
})

// A card whose reading failed is still a card the engine can use, so it must
// not drop out of the count and leave its neighbour looking unambiguous.
test('assess: a second GPU with an unusable reading still makes the choice ambiguous', (t) => {
  const resources = discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB })
  const gpus = resources.capabilities.gpus
  const samples = resources.sample!.gpus
  if (gpus.status === 'supported' && samples.status === 'supported') {
    gpus.value.push({ ...gpus.value[0]!, id: 'gpu1' })
    samples.value.push({
      ...samples.value[0]!,
      id: 'gpu1',
      memoryTotalBytes: { status: 'failed', reason: 'sampling failed' },
      memoryUsedBytes: { status: 'failed', reason: 'sampling failed' }
    })
  }

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources,
    platform: 'linux-x64',
    calibration: calibration(),
    resolveGpuCalibration: () => calibration(),
    resolveProfile: () => profile()
  })

  t.is(result.basis, 'system-memory', 'no device budget is formed')
  t.is(result.verdict, 'unknown')
})
