import test from 'brittle'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
import type { NativeCandidateFit } from '@/resources/model-fit/assess'
import { computeFloor, FLOOR_VERSION } from '@/resources/model-fit/floor'
import type { GgufFacts, ModelResourceProfile } from '@/schemas/model-resource-profile'
import type { SystemResources } from '@/schemas/system-resources'
import type { ModelFitEstimateTarget } from '@/schemas/assess-model-fit'

const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

const F16 = 2
const Q8_0 = 34 / 32

/** One engine verdict, with the figures a set is summed from. */
function measured(
  weightsBytes: number,
  computeBytes: number,
  verdict: 'fit' | 'does-not-fit' = 'fit',
  rest: { contextBytes?: number; hostBytes?: number } = {}
): NativeCandidateFit {
  const contextBytes = rest.contextBytes ?? 0
  const hostBytes = rest.hostBytes ?? 0

  return {
    fit: {
      verdict,
      basis: 'native-probe',
      estimatorVersion: 'native-probe-v2',
      reason: verdict === 'fit' ? 'fits' : 'does-not-fit',
      projection: {
        weightsBytes,
        contextBytes,
        computeBytes,
        deviceBytes: weightsBytes + contextBytes + computeBytes,
        hostBytes
      }
    }
  }
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

function bareFit(verdict: 'fit' | 'does-not-fit' = 'fit'): NativeCandidateFit {
  return {
    fit: { verdict, basis: 'native-probe', estimatorVersion: 'native-probe-v2', reason: verdict }
  }
}

function candidate(overrides: Partial<ModelFitEstimateTarget> = {}): ModelFitEstimateTarget {
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
// Budget and reserve
// ---------------------------------------------------------------------------

test('assess: desktop reserve is 20% of available, capped at 2 GiB', (t) => {
  const small = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
    platform: 'darwin-arm64',
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
    resolveProfile: () => profile({ artifactBytes: 2 * GIB }),
    nativeFits: [measured(2 * GIB, 0)]
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
    resolveProfile: () => profile()
  })
  t.is(result.basis, 'system-memory')
  t.is(result.budget?.reservedBytes, 1 * GIB, '20% of the 6 GiB available, capped at 1 GiB')
  t.ok(result.assumptions.some((a) => a.includes('android budgets deliberately use system memory')))
})

test('assess: a measured verdict stands where the host reports no memory', (t) => {
  const base = resources()

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: { capabilities: base.capabilities },
    platform: 'android-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.models[0]?.verdict, 'likely-fits')
  t.is(result.evidence, 'native-fit')
  t.absent(result.budget)
})

test('assess: a refusal stands where the host reports no memory', (t) => {
  const base = resources()

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: { capabilities: base.capabilities },
    platform: 'android-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0, 'does-not-fit')]
  })

  t.is(result.verdict, 'likely-too-large')
})

// Each was measured alone, so nothing says they hold together.
test('assess: a set with no budget stays unknown even when each was measured', (t) => {
  const base = resources()

  const result = assessModelFitFromResources({
    models: [candidate(), candidate({ model: { name: 'second', sha256Checksum: 'b'.repeat(64) } })],
    execution: 'sequential',
    resources: { capabilities: base.capabilities },
    platform: 'android-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0), measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'unknown')
})

test('assess: unusable or inconsistent memory evidence yields unknown', (t) => {
  const base = resources()

  const noSample = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: { capabilities: base.capabilities },
    platform: 'darwin-arm64',
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
    resolveProfile: () => profile()
  })
  t.is(unsupported.verdict, 'unknown')
  t.ok(unsupported.reasons.some((r) => r.includes('not supported')))

  const inconsistent = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 9 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile()
  })
  t.is(inconsistent.verdict, 'unknown')
  t.ok(inconsistent.reasons.some((r) => r.includes('inconsistent')))
})

// ---------------------------------------------------------------------------
// Verdict boundaries
// ---------------------------------------------------------------------------

test('assess: measured demand is compared against the budget exactly', (t) => {
  // 8 GiB total, 3 GiB used => 5 GiB available, 1 GiB reserved => 4 GiB budget.
  const at = (persistent: number) =>
    assessModelFitFromResources({
      models: [candidate()],
      execution: 'sequential',
      resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
      platform: 'darwin-arm64',
      resolveProfile: () => profile(),
      nativeFits: [measured(persistent, 0)]
    })

  t.is(at(4 * GIB).verdict, 'likely-fits', 'demand exactly equal to the budget fits')
  t.is(at(4 * GIB + 1).verdict, 'likely-too-large', 'one byte over does not')
})

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('assess: sequential takes the largest working peak, concurrent sums them', (t) => {
  const models: ModelFitEstimateTarget[] = [
    candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
    candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
  ]
  // Each model: 1 GiB resident, 1 GiB working. Resident always sums to 2 GiB;
  // the peak adds 1 GiB sequentially and 2 GiB concurrently.
  const fits = [measured(1 * GIB, 1 * GIB), measured(1 * GIB, 1 * GIB)]

  // 4.5 GiB free, 20% reserved: a 3.6 GiB budget, which holds the sequential
  // total of 3 GiB but not the concurrent total of 4 GiB.
  const assess = (execution: 'sequential' | 'concurrent') =>
    assessModelFitFromResources({
      models,
      execution,
      resources: resources({ totalBytes: 4.5 * GIB, usedBytes: 0 }),
      platform: 'darwin-arm64',
      resolveProfile: () => profile(),
      nativeFits: fits
    })

  t.is(assess('sequential').verdict, 'likely-fits')
  t.is(assess('concurrent').verdict, 'likely-too-large')
})

test('assess: every KV cache is counted, sequential or not', (t) => {
  const models: ModelFitEstimateTarget[] = [
    candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
    candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
  ]
  // 1 GiB of weights and a 1 GiB KV cache each, no compute buffers. Both caches
  // are resident whether or not the models run at once, so the set needs 4 GiB.
  const fits = [
    measured(1 * GIB, 0, 'fit', { contextBytes: 1 * GIB }),
    measured(1 * GIB, 0, 'fit', { contextBytes: 1 * GIB })
  ]

  // 4.5 GiB free, 20% reserved: a 3.6 GiB budget.
  const assess = (execution: 'sequential' | 'concurrent') =>
    assessModelFitFromResources({
      models,
      execution,
      resources: resources({ totalBytes: 4.5 * GIB, usedBytes: 0 }),
      platform: 'darwin-arm64',
      resolveProfile: () => profile(),
      nativeFits: fits
    })

  t.is(assess('sequential').verdict, 'likely-too-large')
  t.is(assess('concurrent').verdict, 'likely-too-large')
})

test('assess: every model measured by its engine reports native evidence', (t) => {
  const result = assessModelFitFromResources({
    models: [
      candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
      candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
    ],
    execution: 'concurrent',
    resources: resources(),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0), measured(1 * GIB, 0)]
  })

  t.is(result.evidence, 'native-fit')
  t.is(result.models[0]!.evidence, 'native-fit')
  t.is(result.models[1]!.evidence, 'native-fit')
  t.ok(result.reasons.some((r) => r.includes('measured by the engine')))
})

test('assess: a model the engine could not measure falls back to its floor', (t) => {
  const result = assessModelFitFromResources({
    models: [
      candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
      candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
    ],
    execution: 'concurrent',
    resources: resources(),
    platform: 'darwin-arm64',
    resolveProfile: () => profile({ artifactBytes: 1 * GIB, ggufFacts: undefined }),
    nativeFits: [measured(1 * GIB, 0), { unavailable: 'no registry description (timed-out)' }]
  })

  t.is(result.evidence, 'computed-only', 'a floor among measured models weakens the set')
  t.ok(
    result.reasons.some((r) => r.includes('no engine fit for B')),
    'the model that lost its verdict is named'
  )
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
    resolveProfile: (checksum) => (checksum === 'a'.repeat(64) ? profile() : undefined),
    nativeFits: [measured(1 * GIB, 0), {}]
  })

  t.is(result.verdict, 'unknown')
  t.is(result.models[0]!.verdict, 'likely-fits', 'the known model still reports its own verdict')
  t.is(result.models[1]!.verdict, 'unknown')
  t.ok(result.models[1]!.reasons.some((r) => r.includes('no resource profile')))
  t.absent(result.evidence, 'a set with an unassessable model names no evidence')
  t.absent(result.floorBytes)
})

test('assess: floors are aggregated under execution and the reason says so', (t) => {
  // Two 3 GiB models on an 8 GiB phone with a 5 GiB budget: each fits its
  // floor alone, together they do not.
  const phone = resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB })
  const models = [
    candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
    candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
  ]
  const assess = (execution: 'sequential' | 'concurrent') =>
    assessModelFitFromResources({
      models,
      execution,
      resources: phone,
      platform: 'android-arm64',
      resolveProfile: () => profile({ artifactBytes: 3 * GIB, ggufFacts: undefined })
    })

  const sequential = assess('sequential')
  t.is(sequential.models[0]!.verdict, 'unknown')
  t.is(sequential.models[1]!.verdict, 'unknown')
  t.is(sequential.verdict, 'likely-too-large', 'the summed floors exceed the budget')
  t.is(sequential.evidence, 'computed-only')
  t.is(sequential.floorBytes, 6 * GIB)
  t.ok(
    sequential.reasons.some((r) => r.includes('only the largest working peak added')),
    'the aggregation is explained under computed-only evidence too'
  )

  const concurrent = assess('concurrent')
  t.ok(concurrent.reasons.some((r) => r.includes('every working peak added')))
})

test('assess: a model no engine measured yields unknown, never likely-fits, inside the budget', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: 'linux-arm64',
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.budget, 'the budget is still reported')
  t.is(result.models[0]!.verdict, 'unknown')
  t.is(result.evidence, 'computed-only', 'what evidence there is, is the computed floor')
  t.ok(result.floorBytes, 'the floor itself is reported')
})

test('assess: an unrecognized platform yields unknown', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: undefined,
    resolveProfile: () => profile()
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.reasons.some((r) => r.includes('not one this assessment covers')))
  t.is(result.models[0]!.verdict, 'unknown')
})

// Every engine without a fitter lands here, which is most of them.
test('assess: an engine with no fitter falls back to its floor', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources(),
    platform: 'darwin-arm64',
    resolveProfile: () => profile({ engine: 'nmtcpp-translation', ggufFacts: undefined })
  })

  t.is(result.verdict, 'unknown', 'a floor inside the budget confirms nothing')
  t.is(result.evidence, 'computed-only')
  t.ok(result.models[0]!.reasons.some((r) => r.includes('weights only')))
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
    resolveProfile: (checksum) => (checksum === 'a'.repeat(64) ? profile() : undefined)
  })

  t.is(result.verdict, 'unknown')
  t.ok(result.models[0]!.reasons.some((r) => r.includes('`artifacts`')))
})

// ---------------------------------------------------------------------------
// Computed floor — the zero-fetch gate where no engine answered
// ---------------------------------------------------------------------------

// Every term a load adds on top of the weights and the KV cache is
// non-negative, so a floor counting only those two holds on any platform and
// any backend. That is what lets it refuse without a measurement, and why it
// can never confirm.

test('computeFloor: a llama.cpp floor is the weights plus the KV cache at the narrowest default width', (t) => {
  const elements = 32 * 8 * 256 * 4096

  const floor = computeFloor({
    profile: profile({ artifactBytes: 4_000_000_000 }),
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 500_000_000
  })
  t.is(
    floor.bytes,
    Math.ceil(4_500_000_000 + elements * Q8_0),
    'model plus companions plus a q8_0 cache: the GPU default, which is the cheaper one'
  )
  t.ok(floor.assumptions.some((a) => a.includes('q8_0')))
  t.ok(floor.assumptions.some((a) => a.includes('cannot overstate the cost')))

  const bitnet = computeFloor({
    profile: profile({ artifactBytes: 0, ggufFacts: denseFacts({ architecture: 'bitnet' }) }),
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 0
  })
  t.is(bitnet.bytes, elements * F16, 'flash attention off keeps the cache f16 on every backend')

  const clamped = computeFloor({
    profile: profile({ artifactBytes: 0, ggufFacts: denseFacts({ contextLength: 2048 }) }),
    workload: { kind: 'llm', contextTokens: 1_000_000 },
    extraArtifactBytes: 0
  })
  t.is(clamped.bytes, Math.ceil(32 * 8 * 256 * 2048 * Q8_0), 'sized for the trained context')
  t.ok(clamped.assumptions.some((a) => a.includes('clamped to the trained context')))
})

test('computeFloor: without a sized KV cache the floor is the weights alone', (t) => {
  const noFacts = computeFloor({
    profile: { schemaVersion: 1, engine: 'llamacpp-completion', artifactBytes: 123 },
    workload: { kind: 'llm', contextTokens: 4096 },
    extraArtifactBytes: 0
  })
  t.is(noFacts.bytes, 123)
  t.ok(noFacts.reasons.some((r) => r.includes('weights only')))

  const audioOnLlama = computeFloor({
    profile: profile({ artifactBytes: 123 }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0
  })
  t.is(audioOnLlama.bytes, 123, 'a workload with no context sizes no cache')

  const whisper = computeFloor({
    profile: profile({
      engine: 'whispercpp-transcription',
      artifactBytes: 123,
      ggufFacts: undefined
    }),
    workload: { kind: 'audio', windowMs: 30_000, streaming: false },
    extraArtifactBytes: 0
  })
  t.is(whisper.bytes, 123)
  t.ok(whisper.reasons.some((r) => r.includes('engine-owned')))

  const tts = computeFloor({
    profile: profile({ engine: 'tts-ggml', artifactBytes: 123, ggufFacts: undefined }),
    workload: { kind: 'llm', contextTokens: 1 },
    extraArtifactBytes: 0
  })
  t.is(tts.bytes, 123, 'an engine with no estimator still has a file size')
})

test('assess: a model with no engine verdict refuses from the computed floor and never confirms a fit', (t) => {
  // An 8 GiB phone with 2 GiB in use: 6 GiB available, the mobile reserve
  // capped at 1 GiB, a 5 GiB budget.
  const phone = resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB })
  const kv = Math.ceil(32 * 8 * 256 * 4096 * Q8_0)
  const assess = (artifactBytes: number) =>
    assessModelFitFromResources({
      models: [candidate({ workload: { kind: 'llm', contextTokens: 4096 } })],
      execution: 'sequential',
      resources: phone,
      platform: 'android-arm64',
      resolveProfile: () => profile({ artifactBytes })
    })

  const tooLarge = assess(6 * GIB)
  t.is(tooLarge.verdict, 'likely-too-large')
  t.is(tooLarge.basis, 'system-memory')
  t.is(tooLarge.budget?.availableAfterReserveBytes, 5 * GIB)
  t.is(tooLarge.evidence, 'computed-only')
  t.is(tooLarge.floorBytes, 6 * GIB + kv)
  t.is(tooLarge.models[0]!.verdict, 'likely-too-large')
  t.is(tooLarge.models[0]!.evidence, 'computed-only')
  t.is(tooLarge.models[0]!.floorBytes, 6 * GIB + kv)
  t.is(tooLarge.models[0]!.estimatorVersion, FLOOR_VERSION)
  t.ok(tooLarge.models[0]!.reasons.some((r) => r.includes('floor alone exceeds the budget')))
  t.ok(tooLarge.reasons.some((r) => r.includes('never confirm a fit')))

  const atBudget = assess(5 * GIB - kv)
  t.is(atBudget.verdict, 'unknown', 'a floor exactly at the budget is not over it')
  const justOver = assess(5 * GIB - kv + 1)
  t.is(justOver.verdict, 'likely-too-large', 'one byte over is')

  // A model far inside the budget is still unknown: the floor cannot say what
  // the load adds on top.
  const tiny = assess(10 * MIB)
  t.is(tiny.verdict, 'unknown')
  t.is(tiny.evidence, 'computed-only')
  t.is(tiny.models[0]!.verdict, 'unknown')
  t.ok(tiny.models[0]!.reasons.some((r) => r.includes('a fit cannot be claimed')))
})

test('assess: two floors that each fit alone can still refuse the set together', (t) => {
  // The same 5 GiB budget as above.
  const phone = resources({ totalBytes: 8 * GIB, usedBytes: 2 * GIB })
  const kv = Math.ceil(32 * 8 * 256 * 4096 * Q8_0)
  const result = assessModelFitFromResources({
    models: [
      candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
      candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
    ],
    execution: 'sequential',
    resources: phone,
    platform: 'android-arm64',
    resolveProfile: () => profile({ artifactBytes: 3 * GIB })
  })

  t.is(result.models[0]!.verdict, 'unknown', '3 GiB plus cache is inside a 5 GiB budget')
  t.is(result.models[1]!.verdict, 'unknown')
  t.is(result.verdict, 'likely-too-large', 'both resident at once is not')
  t.is(result.floorBytes, 2 * (3 * GIB + kv), 'floors sum like resident lower bounds')
})

test('assess: iOS refuses from the floor once the per-process allowance is known', (t) => {
  const kv = Math.ceil(32 * 8 * 256 * 4096 * Q8_0)
  const assess = (artifactBytes: number, sample: Parameters<typeof resources>[0]) =>
    assessModelFitFromResources({
      models: [candidate()],
      execution: 'sequential',
      resources: resources(sample),
      platform: 'ios-arm64',
      resolveProfile: () => profile({ artifactBytes })
    })

  // System memory must not stand in for the allowance: no budget, no verdict —
  // but the floor itself is still computed and reported.
  const withoutMetric = assess(6 * GIB, { totalBytes: 8 * GIB, usedBytes: 2 * GIB })
  t.is(withoutMetric.verdict, 'unknown')
  t.absent(withoutMetric.budget)
  t.is(withoutMetric.models[0]!.verdict, 'unknown')
  t.is(withoutMetric.models[0]!.floorBytes, 6 * GIB + kv)
  t.ok(
    withoutMetric.reasons.some((r) => r.includes('per-process allowance metric is not available'))
  )

  // Allowance 2.5 GiB, footprint 1 GiB, mobile reserve 0.5 GiB: a 2 GiB budget.
  const perProcess = { processUsedBytes: 1 * GIB, processAvailableBytes: 2.5 * GIB }
  const tooLarge = assess(6 * GIB, perProcess)
  t.is(tooLarge.basis, 'process-memory')
  t.is(tooLarge.verdict, 'likely-too-large')
  t.is(tooLarge.evidence, 'computed-only')
  t.is(tooLarge.budget?.availableAfterReserveBytes, 2 * GIB)

  const small = assess(1 * GIB, perProcess)
  t.is(small.verdict, 'unknown', 'inside the allowance is still not a fit without a measurement')
})

test('assess: an unrecognized platform still refuses from the floor', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate({ workload: { kind: 'llm', contextTokens: 1 } })],
    execution: 'sequential',
    resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
    platform: undefined,
    resolveProfile: () => profile({ artifactBytes: 5 * GIB })
  })

  t.is(result.verdict, 'likely-too-large', '5 GiB of weights against a 4 GiB budget')
  t.is(result.evidence, 'computed-only')
  t.ok(result.reasons.some((r) => r.includes('not one this assessment covers')))
})

// The floor is the fallback for a model no engine measured, and a set holding
// one can refuse but never confirm.
test('assess: a measured model beside a floor rests on the weaker evidence', (t) => {
  // 8 GiB total, 3 GiB used: a 4 GiB budget.
  const assess = (floorBytes: number) =>
    assessModelFitFromResources({
      models: [
        candidate({ model: { name: 'A', sha256Checksum: 'a'.repeat(64) } }),
        candidate({ model: { name: 'B', sha256Checksum: 'b'.repeat(64) } })
      ],
      execution: 'sequential',
      resources: resources({ totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
      platform: 'darwin-arm64',
      resolveProfile: () => profile({ artifactBytes: floorBytes, ggufFacts: undefined }),
      nativeFits: [measured(1 * GIB, 0), {}]
    })

  const over = assess(5 * GIB)
  t.is(over.models[0]!.evidence, 'native-fit')
  t.is(over.models[1]!.evidence, 'computed-only')
  t.is(over.verdict, 'likely-too-large')
  t.is(over.evidence, 'computed-only', 'the set rests on its weakest evidence')
  t.is(over.floorBytes, 6 * GIB, 'the measured model contributes its own bytes to the total')

  const inside = assess(100 * MIB)
  t.is(inside.verdict, 'unknown', 'one floor in the set means the set is never likely-fits')
})

// A discrete card holds the weights in its own memory, so the system budget
// bounds nothing there: no floor can be compared, and the answer stays unknown.
test('assess: a discrete GPU without coefficients gets no floor', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      systemTotalBytes: 8 * GIB,
      systemUsedBytes: 7 * GIB
    }),
    platform: 'linux-x64',
    resolveProfile: () => profile({ artifactBytes: 6 * GIB })
  })

  t.is(
    result.verdict,
    'unknown',
    '6 GiB against 1 GiB of system RAM proves nothing when the weights may live in VRAM'
  )
  t.absent(result.evidence)
  t.absent(result.floorBytes)
  t.absent(result.models[0]!.floorBytes)
})

// An integrated GPU allocates out of system RAM, so the floor holds there even
// without the shared fixture — the budget measures the memory the load uses.
test('assess: an integrated GPU still gets the floor', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ gpu: true, totalBytes: 8 * GIB, usedBytes: 3 * GIB }),
    platform: 'linux-x64',
    resolveProfile: () => profile({ artifactBytes: 6 * GIB })
  })

  t.is(result.verdict, 'likely-too-large')
  t.is(result.evidence, 'computed-only')
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
  t.is(result.models[0]!.estimatorVersion, FLOOR_VERSION)
})

// ---------------------------------------------------------------------------
// Discrete-GPU platforms
// ---------------------------------------------------------------------------

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

test('assess: a discrete GPU is budgeted against its own memory', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'device-memory')
  t.is(result.budget?.totalBytes, 20 * GIB)
  t.is(result.budget?.usedBytes, 1 * GIB)
  t.is(result.models[0]!.verdict, 'likely-fits')
  t.ok(result.assumptions.some((a) => a.includes('vulkan')))
})

test('assess: host bytes are charged to the system budget, not to the card', (t) => {
  // 4 GiB on a card with 6 GiB free, 8 GiB in host RAM.
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 8 * GIB, vramUsedBytes: 2 * GIB }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(4 * GIB, 0, 'fit', { hostBytes: 8 * GIB })]
  })

  t.is(result.basis, 'device-memory')
  t.is(result.verdict, 'likely-fits')
  t.is(result.models[0]!.verdict, 'likely-fits')
})

test('assess: host bytes still refuse when the host itself has no room', (t) => {
  // The card holds its 4 GiB, but 12 GiB does not fit a host with 10 GiB free.
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 8 * GIB,
      vramUsedBytes: 2 * GIB,
      systemTotalBytes: 16 * GIB,
      systemUsedBytes: 6 * GIB
    }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(4 * GIB, 0, 'fit', { hostBytes: 8 * GIB })]
  })

  t.is(result.verdict, 'likely-too-large')
})

test('assess: a GPU with too little VRAM is too large even on a roomy host', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 2 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
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
      resolveProfile: () => profile(),
      nativeFits: [measured(1 * GIB, 0)]
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

// Cards that disagree on the backend name no single device to budget against,
// so the set falls back to the system budget the engine's bytes also sit in.
test('assess: GPUs on different backends fall back to the system budget', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({
      vramTotalBytes: 20 * GIB,
      vramUsedBytes: 1 * GIB,
      extraGpus: [{ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB, backend: 'rocm' }]
    }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.budget?.totalBytes, 20 * GIB, 'the real card carries the budget on its own')
  t.ok(result.assumptions.some((a) => a.includes('Test Discrete GPU')))
})

// A VM's paravirtual display adapter is enumerated as a GPU by the collector,
// but the engine has no backend for it and runs on the CPU. Cloud hosts and CI
// runners are the common case.
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'system-memory')
  t.is(result.verdict, 'likely-fits', 'the platform fixture applies, as it would with no GPU')
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
})

// An AMD APU under amdgpu exposes a VRAM carve-out, so libgpuinfo infers
// `dedicated` from sysfs and `unifiedMemory` reads false — a Ryzen 5000U
// laptop reported over a gigabyte of "VRAM". Budgeting against the carve-out
// would be wrong, so the set keeps the system budget.
test('assess: an AMD GPU on linux is not budgeted against its carve-out', (t) => {
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.basis, 'system-memory', 'and no device budget is formed from the carve-out')

  // The same card on windows is unambiguous: DXGI reports real dedicated VRAM.
  const onWindows = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: discreteGpuResources({ vramTotalBytes: 20 * GIB, vramUsedBytes: 1 * GIB }),
    platform: 'win32-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })
  t.is(onWindows.verdict, 'likely-fits')
})

// ---------------------------------------------------------------------------
// Integrated GPUs — the ordinary consumer desktop
// ---------------------------------------------------------------------------

// An integrated GPU allocates out of system RAM, so the engine runs on the GPU
// while the system basis still bounds it.
test('assess: an integrated GPU keeps the system basis', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ gpu: true }),
    platform: 'linux-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'system-memory')
  t.is(result.verdict, 'likely-fits')
  t.ok(result.assumptions.some((a) => a.includes('integrated GPU allocates out of system RAM')))
})

// The host `win32-x64:vulkan-shared` exists for: an ordinary Windows laptop
// whose only GPU is the Intel iGPU. DXGI types it dedicated for a 128 MiB
// carve-out and `unifiedMemory` reads false, so the size floor is the only
// thing that identifies it — and with no discrete card beside it, nothing else
// can carry the budget.
test('assess: a Windows laptop with only an iGPU keeps the system basis', (t) => {
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

  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: igpuOnly,
    platform: 'win32-x64',
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'system-memory', 'not the 128 MiB carve-out')
  t.is(result.budget?.totalBytes, 32 * GIB)
  t.is(result.verdict, 'likely-fits')
  t.ok(result.assumptions.some((a) => a.includes('Intel(R) UHD Graphics 770')))
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'device-budget')
  t.is(result.verdict, 'likely-fits')
  t.is(result.models[0]!.verdict, 'likely-fits')
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
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
    resolveProfile: () => profile(),
    nativeFits: [measured(1 * GIB, 0)]
  })

  t.is(result.basis, 'system-memory', 'no device budget is formed')
  t.is(result.verdict, 'likely-fits')
})

// ---------------------------------------------------------------------------
// Native fit from the registry's stub
// ---------------------------------------------------------------------------

test('assess: the engine fitter answers for one model', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(2 * GIB, 0)]
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.evidence, 'native-fit')
  t.is(result.models[0]?.evidence, 'native-fit')
  t.is(result.models[0]?.estimatorVersion, 'native-probe-v2')
  t.ok(result.budget, 'the memory sample is still reported')
})

test('assess: a refusal from the engine stands', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(2 * GIB, 0, 'does-not-fit')]
  })

  t.is(result.verdict, 'likely-too-large')
  t.is(result.evidence, 'native-fit')
})

// Audiogen reports a peak across pipeline phases and diffusion a per-module
// table, so neither divides into a breakdown. The refusal is the whole answer.
test('assess: a refusal with no breakdown still refuses', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [
      {
        fit: {
          verdict: 'does-not-fit',
          basis: 'native-probe',
          estimatorVersion: 'native-probe-v2',
          reason: 'does-not-fit'
        }
      }
    ]
  })

  t.is(result.verdict, 'likely-too-large')
  t.is(result.evidence, 'native-fit')
  t.is(result.models[0]?.verdict, 'likely-too-large')
  t.is(result.models[0]?.evidence, 'native-fit')
  t.absent(result.floorBytes, 'a bare refusal contributes no floor')
})

test('assess: a fit with no breakdown stands for a lone candidate', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [bareFit()]
  })

  t.is(result.verdict, 'likely-fits')
  t.is(result.evidence, 'native-fit')
  t.is(result.models[0]?.verdict, 'likely-fits')
  t.is(result.models[0]?.estimatorVersion, 'native-probe-v2')
})

test('assess: a fit with no breakdown falls back inside a set', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate(), candidate({ model: { name: 'second', sha256Checksum: 'b'.repeat(64) } })],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [bareFit(), measured(1 * GIB, 0)]
  })

  t.is(result.evidence, 'computed-only')
  t.not(result.verdict, 'likely-fits', 'a floor can never confirm the set')
})

test('assess: an undecided probe leaves the model to its floor', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [
      {
        fit: {
          verdict: 'unknown',
          basis: 'native-probe',
          estimatorVersion: 'native-probe-v2',
          reason: 'disabled'
        }
      }
    ]
  })

  t.is(result.evidence, 'computed-only')
  t.ok(
    result.reasons.some((r) => r.includes('reached no verdict for') && r.includes('disabled')),
    'the model that reached no verdict is named beside the fallback'
  )
})

test('assess: a probe that never ran names why, beside the fallback', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate()],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [{ unavailable: 'no registry description (timed-out)' }]
  })

  t.is(result.evidence, 'computed-only')
  t.ok(
    result.reasons.some((r) => r.includes('no registry description (timed-out)')),
    'the cause travels with the result'
  )
})

test('assess: the resolved device survives onto the model result', (t) => {
  const result = assessModelFitFromResources({
    models: [candidate({ device: 'gpu' })],
    execution: 'sequential',
    resources: resources({ totalBytes: 64 * GIB, usedBytes: 16 * GIB }),
    platform: 'darwin-arm64',
    resolveProfile: () => profile(),
    nativeFits: [measured(2 * GIB, 0)]
  })

  t.is(result.models[0]?.device, 'gpu')
})
