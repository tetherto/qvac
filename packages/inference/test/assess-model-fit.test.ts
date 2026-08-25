import test from 'brittle'
import { estimateLlm, LLM_ESTIMATOR_VERSION } from '@/resources/model-fit/estimators/llm'
import { estimateWhisper } from '@/resources/model-fit/estimators/whisper'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
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

function resources(options: { totalBytes?: number; usedBytes?: number; gpu?: boolean } = {}) {
  const total = options.totalBytes ?? 64 * GIB
  const used = options.usedBytes ?? 16 * GIB
  const provenance = { source: 'test', scope: 'system' as const }

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
        totalBytes: { status: 'supported', value: total, provenance }
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
      sha256Checksum: 'a'.repeat(64),
      engine: 'llamacpp-completion',
      expectedSize: 1_000_000_000
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
  t.is(result.working.lower, expected)
  t.is(result.working.upper, expected, 'no GPU, so both bounds use the f16 default')
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
  t.is(result.working.lower, Math.ceil(elements * Q8_0), 'GPU default is q8_0')
  t.is(result.working.upper, elements * F16, 'CPU or OpenCL backend keeps f16')
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
  t.is(result.working.lower, result.working.upper)
  t.is(result.working.lower, 32 * 8 * 256 * 4096 * F16)
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
  t.is(result.working.lower, 32 * 8 * 256 * 2048 * F16, 'sized for 2048, not 1,000,000')
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
  t.is(result.working.lower, windowed + full)

  // What the per-layer sum buys: reading every block as the widest one is 18x
  // larger here, and worse still at the model's full 262144-token context.
  const flat = 60 * 16 * (512 + 512) * contextTokens * F16
  t.ok(flat / result.working.upper > 15, 'the flat maximum is more than 15x the per-layer sum')
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
  t.is(result.working.lower, 8 * perBlockPerToken * contextTokens * F16 + ssm)
  t.is(result.working.upper, 8 * perBlockPerToken * contextTokens * F16 + ssm)
  t.ok(result.assumptions.some((a) => a.includes('every 4 blocks')))

  const flat = 32 * perBlockPerToken * contextTokens * F16
  t.ok(result.working.upper < flat, 'hybrid accounting is below the flat all-blocks figure')
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
  t.is(result.working.lower, 24 * perBlockPerToken * 128 * F16, 'every block windowed')
  t.is(result.working.upper, 24 * perBlockPerToken * contextTokens * F16, 'every block full')
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
  t.is(result.persistent.lower, 4_500_000_000, 'model plus companion artifacts')
  t.is(result.persistent.upper, Math.ceil(4_500_000_000 * 1.05))
  t.ok(result.assumptions.some((a) => a.includes('file-backed and evictable')))
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

// ---------------------------------------------------------------------------
// Budget and reserve
// ---------------------------------------------------------------------------

test('assess: desktop reserve is the larger of 2 GiB and 15%', (t) => {
  const small = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(small.budget?.reservedBytes, 2 * GIB, '15% of 8 GiB is below the 2 GiB floor')
  t.is(small.budget?.availableAfterReserveBytes, 4 * GIB)

  const large = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(large.budget?.reservedBytes, 64 * GIB * 0.15, '15% dominates on a large machine')
})

test('assess: mobile reserve is the larger of 1 GiB and 20%', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB }),
    platform: 'ios-arm64',
    calibration: calibration(),
    resolveProfile: () => profile()
  })
  t.is(result.budget?.reservedBytes, 8 * GIB * 0.2)
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
  t.ok(noSample.reasons.some((r) => r.includes('no system-memory sample')))

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
          totalBytes: { status: 'unavailable' }
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
  // Budget: 8 GiB total, 2 GiB used, 2 GiB reserved => 4 GiB available.
  function verdictFor(artifactBytes: number, weightUpperCoeff: number) {
    return assessModelFitFromResources({
      models: [candidate({ workload: { kind: 'llm', contextTokens: 1 } })],
      execution: 'sequential',
      resources: resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB }),
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

test('assess: sequential takes the largest peak, concurrent sums them', (t) => {
  const cal = calibration({ fixedOverheadBytes: { lower: 1 * GIB, upper: 1 * GIB } })
  const facts = denseFacts({ blockCount: 1, headCountKv: 1, contextLength: 8192 })

  const models: ModelFitCandidate[] = [
    candidate({
      model: {
        name: 'A',
        sha256Checksum: 'a'.repeat(64),
        engine: 'llamacpp-completion',
        expectedSize: 0
      },
      workload: { kind: 'llm', contextTokens: 1 }
    }),
    candidate({
      model: {
        name: 'B',
        sha256Checksum: 'b'.repeat(64),
        engine: 'llamacpp-completion',
        expectedSize: 0
      },
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

  // Both keep 2 × 2 GiB resident; the peaks are 1 GiB + 512 B each.
  const persistent = 4 * GIB
  const peak = 1 * GIB + 512
  t.is(sequential.estimate?.lowerBoundBytes, persistent + peak)
  t.is(concurrent.estimate?.lowerBoundBytes, persistent + 2 * peak)
  t.is(sequential.execution, 'sequential')
  t.is(concurrent.execution, 'concurrent')
})

// ---------------------------------------------------------------------------
// Unknown propagation
// ---------------------------------------------------------------------------

test('assess: one unknown model makes the combined verdict unknown', (t) => {
  const known = candidate({
    model: {
      name: 'KNOWN',
      sha256Checksum: 'a'.repeat(64),
      engine: 'llamacpp-completion',
      expectedSize: 0
    }
  })
  const unknown = candidate({
    model: {
      name: 'UNKNOWN',
      sha256Checksum: 'b'.repeat(64),
      engine: 'llamacpp-completion',
      expectedSize: 0
    }
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
        artifacts: [
          {
            name: 'VAD',
            sha256Checksum: 'c'.repeat(64),
            engine: 'onnx-vad',
            expectedSize: 1_000
          }
        ]
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
