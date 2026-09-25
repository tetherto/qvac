import type { Step, TestDefinition } from '@qvac/test-suite'

// Six of these stay on their executors. They feed the model tensors the test
// generates -- images of a given shape, a state vector, token ids, an
// attention mask -- and a step can name data but not compute it, so the
// vocabulary has no way to describe "a zero-filled Float32Array of
// chunkSize × actionDim". The four `hparams` tests, which only read the loaded
// model's shape back, are migrated.
//
// SmolVLA-LIBERO inference always returns a chunkSize × actionDim Float32Array
// of robot actions plus per-stage timings. These tests exercise the SDK's
// `vla()` / `vlaHparams()` client functions end-to-end against a registry-
// loaded model — the real LIBERO numerical correctness check lives in the
// addon's own integration suite (which has access to the PyTorch reference
// fixtures); here we focus on the SDK shape contract.

const createVlaTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: 'type'; expectedType: 'string' | 'number' | 'array' }
    | { validation: 'function'; fn: (result: unknown) => { passed: boolean; output?: string } },
  estimatedDurationMs: number = 300000,
  suites?: string[],
  dependency: string = 'vla'
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(suites && { suites }),
  metadata: { category: 'vla', dependency, estimatedDurationMs }
})

// hparams shape: chunkSize, actionDim, maxStateDim, etc. must all be
// positive integers and backendName must be one of the addon's accepted
// backend strings (CPU when we load with `{ backend: "cpu" }`).
export const vlaHparamsShape = createVlaTest(
  'vla-hparams-shape',
  {},
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number>; backendName?: string | null }
      if (!r.hparams) return { passed: false, output: 'missing hparams' }
      const required = [
        'chunkSize',
        'actionDim',
        'maxActionDim',
        'maxStateDim',
        'tokenizerMaxLength',
        'visionImageSize'
      ]
      for (const k of required) {
        const v = r.hparams[k]
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          return { passed: false, output: `hparams.${k} not a positive integer (got ${v})` }
        }
      }
      const knownBackends = new Set(['CPU', 'Metal', 'Vulkan', 'OpenCL'])
      if (r.backendName !== null && !knownBackends.has(r.backendName ?? '')) {
        return { passed: false, output: `unknown backendName: ${r.backendName}` }
      }
      return { passed: true }
    }
  },
  60000,
  ['smoke']
)

// Synthetic inputs: zero-filled gray images + BOS-only tokens + zero state
// + zero noise. The model still runs the full pipeline (vision encoder +
// SmolLM2 prefill + flow-matching ODE) and produces a syntactically valid
// action chunk; we don't assert on the action values because they're
// undefined-behaviour-ish on degenerate inputs.
export const vlaRunSyntheticShape = createVlaTest(
  'vla-run-synthetic-shape',
  { inputs: 'synthetic' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as {
        actionsLength?: number
        expectedLength?: number
        actionDim?: number
        chunkSize?: number
      }
      if (r.actionsLength !== r.expectedLength) {
        return {
          passed: false,
          output: `actions.length=${r.actionsLength} != chunkSize*actionDim=${r.expectedLength}`
        }
      }
      if (!r.actionDim || !r.chunkSize) {
        return { passed: false, output: 'actionDim/chunkSize missing on result' }
      }
      return { passed: true }
    }
  },
  300000,
  ['smoke']
)

// Per-stage timings should all be non-negative numbers and the total wall
// time should be >0 on real inference.
export const vlaRunStats = createVlaTest(
  'vla-run-stats',
  { inputs: 'synthetic' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { stats?: Record<string, number> }
      if (!r.stats) return { passed: false, output: 'stats missing' }
      const keys = ['vision_ms', 'smollm2_compute_ms', 'smollm2_total_ms', 'ode_ms', 'total_ms']
      for (const k of keys) {
        const v = r.stats[k]
        if (typeof v !== 'number' || v < 0) {
          return { passed: false, output: `stats.${k} not a non-negative number (got ${v})` }
        }
      }
      if (!(r.stats['total_ms']! > 0)) {
        return { passed: false, output: `stats.total_ms must be > 0 (got ${r.stats['total_ms']})` }
      }
      return { passed: true }
    }
  }
)

// `imgWidth ≠ hparams.visionImageSize` must reject cleanly with a
// QvacError mentioning the mismatch, and the model must remain usable
// for a follow-up canonical-shape run() — the JS-side validator clears
// `_hasActiveResponse` on the rejection path.
export const vlaInvalidImgSize = createVlaTest(
  'vla-invalid-img-size',
  { inputs: 'synthetic-wrong-img-size' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { rejected?: boolean; recoveryRan?: boolean; errorMsg?: string }
      if (!r.rejected)
        return { passed: false, output: 'expected run() to reject on img-size mismatch' }
      if (!/imgWidth|imgHeight|visionImageSize/i.test(r.errorMsg ?? '')) {
        return {
          passed: false,
          output: `error message did not mention img dims (got: ${r.errorMsg})`
        }
      }
      if (!r.recoveryRan) {
        return {
          passed: false,
          output: 'follow-up canonical run() did not succeed after rejection'
        }
      }
      return { passed: true }
    }
  }
)

// ── π₀.₅ (pi05) ──────────────────────────────────────────────────────────
// Same SDK shape contract as SmolVLA, against the `vla-pi05` resource
// (3 cameras, discrete state). The shared, hparams-driven executor reads
// `hparams.numCameras` / `hparams.stateInputMode` to shape inputs, so the
// only per-arch differences are the model and a couple of extra assertions:
// the hparams test checks numCameras === 3 / stateInputMode === "discrete",
// and the stats test checks the architecture-neutral prefill_* timing keys.

export const vlaPi05HparamsShape = createVlaTest(
  'vla-pi05-hparams-shape',
  {},
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number | string>; backendName?: string | null }
      if (!r.hparams) return { passed: false, output: 'missing hparams' }
      const required = [
        'chunkSize',
        'actionDim',
        'maxActionDim',
        'maxStateDim',
        'tokenizerMaxLength',
        'visionImageSize'
      ]
      for (const k of required) {
        const v = r.hparams[k]
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          return { passed: false, output: `hparams.${k} not a positive integer (got ${v})` }
        }
      }
      if (r.hparams['numCameras'] !== 3) {
        return {
          passed: false,
          output: `hparams.numCameras expected 3 (got ${r.hparams['numCameras']})`
        }
      }
      if (r.hparams['stateInputMode'] !== 'discrete') {
        return {
          passed: false,
          output: `hparams.stateInputMode expected "discrete" (got ${r.hparams['stateInputMode']})`
        }
      }
      const knownBackends = new Set(['CPU', 'Metal', 'Vulkan', 'OpenCL'])
      if (r.backendName !== null && !knownBackends.has(r.backendName ?? '')) {
        return { passed: false, output: `unknown backendName: ${r.backendName}` }
      }
      return { passed: true }
    }
  },
  60000,
  ['smoke'],
  'vla-pi05'
)

// Exercises the 3-camera + discrete-state path: the executor feeds three
// camera frames, an empty state buffer, and a noise prior (required by pi05).
export const vlaPi05RunSyntheticShape = createVlaTest(
  'vla-pi05-run-synthetic-shape',
  { inputs: 'synthetic' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as {
        actionsLength?: number
        expectedLength?: number
        actionDim?: number
        chunkSize?: number
        numImages?: number
        stateLength?: number
      }
      if (r.actionsLength !== r.expectedLength) {
        return {
          passed: false,
          output: `actions.length=${r.actionsLength} != chunkSize*actionDim=${r.expectedLength}`
        }
      }
      if (!r.actionDim || !r.chunkSize) {
        return { passed: false, output: 'actionDim/chunkSize missing on result' }
      }
      if (r.numImages !== 3) {
        return { passed: false, output: `expected 3 camera images for pi05 (got ${r.numImages})` }
      }
      if (r.stateLength !== 0) {
        return {
          passed: false,
          output: `discrete-state pi05 should run with an empty state (got length ${r.stateLength})`
        }
      }
      return { passed: true }
    }
  },
  300000,
  ['smoke'],
  'vla-pi05'
)

export const vlaPi05RunStats = createVlaTest(
  'vla-pi05-run-stats',
  { inputs: 'synthetic' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { stats?: Record<string, number> }
      if (!r.stats) return { passed: false, output: 'stats missing' }
      const keys = ['vision_ms', 'prefill_compute_ms', 'prefill_total_ms', 'ode_ms', 'total_ms']
      for (const k of keys) {
        const v = r.stats[k]
        if (typeof v !== 'number' || v < 0) {
          return { passed: false, output: `stats.${k} not a non-negative number (got ${v})` }
        }
      }
      if (!(r.stats['total_ms']! > 0)) {
        return { passed: false, output: `stats.total_ms must be > 0 (got ${r.stats['total_ms']})` }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-pi05'
)

export const vlaPi05InvalidImgSize = createVlaTest(
  'vla-pi05-invalid-img-size',
  { inputs: 'synthetic-wrong-img-size' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { rejected?: boolean; recoveryRan?: boolean; errorMsg?: string }
      if (!r.rejected)
        return { passed: false, output: 'expected run() to reject on img-size mismatch' }
      if (!/imgWidth|imgHeight|visionImageSize/i.test(r.errorMsg ?? '')) {
        return {
          passed: false,
          output: `error message did not mention img dims (got: ${r.errorMsg})`
        }
      }
      if (!r.recoveryRan) {
        return {
          passed: false,
          output: 'follow-up canonical run() did not succeed after rejection'
        }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-pi05'
)

// ── GR00T N1.7-3B (LIBERO) ────────────────────────────────────────────────
// Desktop-only against the `vla-groot` resource (q5 profile ~2.74 GB; NOT
// smoke-tagged — too heavy for the quick smoke path). GR00T is the patch-input
// arch: `imageInputMode === 'patches'` (each camera is a pre-patchified buffer
// of `imagePatchElems` floats) with continuous state. Note it reports
// `tokenizerMaxLength: 0` — the prompt length is model-fixed, not surfaced —
// so it is deliberately absent from the positive-integer hparams check below.

export const vlaGrootHparamsShape = createVlaTest(
  'vla-groot-hparams-shape',
  {},
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number | string>; backendName?: string | null }
      if (!r.hparams) return { passed: false, output: 'missing hparams' }
      const required = ['chunkSize', 'actionDim', 'maxActionDim', 'maxStateDim', 'visionImageSize']
      for (const k of required) {
        const v = r.hparams[k]
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          return { passed: false, output: `hparams.${k} not a positive integer (got ${v})` }
        }
      }
      if (r.hparams['imageInputMode'] !== 'patches') {
        return {
          passed: false,
          output: `hparams.imageInputMode expected "patches" (got ${r.hparams['imageInputMode']})`
        }
      }
      const patchElems = r.hparams['imagePatchElems']
      if (typeof patchElems !== 'number' || !Number.isInteger(patchElems) || patchElems <= 0) {
        return {
          passed: false,
          output: `hparams.imagePatchElems not a positive integer (got ${patchElems})`
        }
      }
      if (r.hparams['numCameras'] !== 2) {
        return {
          passed: false,
          output: `hparams.numCameras expected 2 (got ${r.hparams['numCameras']})`
        }
      }
      if (r.hparams['stateInputMode'] !== 'continuous') {
        return {
          passed: false,
          output: `hparams.stateInputMode expected "continuous" (got ${r.hparams['stateInputMode']})`
        }
      }
      const knownBackends = new Set(['CPU', 'Metal', 'Vulkan', 'OpenCL'])
      if (r.backendName !== null && !knownBackends.has(r.backendName ?? '')) {
        return { passed: false, output: `unknown backendName: ${r.backendName}` }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-groot'
)

// Exercises the patch-input path end to end: the executor feeds two per-camera
// patch buffers of `imagePatchElems` floats, a continuous (padded) state, the
// required noise prior, and a prompt with one image-token run per camera.
export const vlaGrootRunSyntheticShape = createVlaTest(
  'vla-groot-run-synthetic-shape',
  { inputs: 'synthetic' },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as {
        actionsLength?: number
        expectedLength?: number
        actionDim?: number
        chunkSize?: number
        numImages?: number
      }
      if (r.actionsLength !== r.expectedLength) {
        return {
          passed: false,
          output: `actions.length=${r.actionsLength} != chunkSize*actionDim=${r.expectedLength}`
        }
      }
      if (!r.actionDim || !r.chunkSize) {
        return { passed: false, output: 'actionDim/chunkSize missing on result' }
      }
      if (r.numImages !== 2) {
        return { passed: false, output: `expected 2 camera images for GR00T (got ${r.numImages})` }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-groot'
)

// ── GR00T N1.7-3B (multi-embodiment) ─────────────────────────────────────
// Desktop-only against the `vla-groot-multi` resource (q5 profile of the
// multi-embodiment GGUF — all 17 trained embodiment rows, default
// `libero_sim`). Exercises the QVAC-23053 surface: the resolved-embodiment
// hparams fields and runtime switching via `vlaSetEmbodiment()`.

export const vlaGrootMultiHparamsShape = createVlaTest(
  'vla-groot-multi-hparams-shape',
  {},
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number | string>; backendName?: string | null }
      if (!r.hparams) return { passed: false, output: 'missing hparams' }
      if (r.hparams['imageInputMode'] !== 'patches') {
        return {
          passed: false,
          output: `hparams.imageInputMode expected "patches" (got ${r.hparams['imageInputMode']})`
        }
      }
      const tag = r.hparams['selectedEmbodimentTag']
      if (typeof tag !== 'string' || tag.length === 0) {
        return {
          passed: false,
          output: `multi-embodiment GGUF must report selectedEmbodimentTag (got ${tag})`
        }
      }
      const catId = r.hparams['selectedEmbodimentCatId']
      if (typeof catId !== 'number' || !Number.isInteger(catId) || catId < 0 || catId > 31) {
        return {
          passed: false,
          output: `selectedEmbodimentCatId not an integer in 0..31 (got ${catId})`
        }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-groot-multi'
)

// Runtime switch round-trip: switch to the 4-camera DROID row (cat_id 24 —
// oracle-validated in vla-ggml PR #3427) via the `{ catId, numCameras }`
// object selector, run inference with inputs rebuilt from the refreshed
// hparams, reject an unknown tag without disturbing the active embodiment,
// and switch back to the original row by plain cat_id — covering both
// selector spellings.
export const vlaGrootMultiSetEmbodiment = createVlaTest(
  'vla-groot-multi-set-embodiment',
  { switchCatId: 24, switchNumCameras: 4 },
  {
    validation: 'function',
    fn: (result: unknown) => {
      const r = result as {
        switchedCatId?: number
        switchedTag?: string
        switchedNumCameras?: number
        ranOnSwitched?: boolean
        unknownTagRejected?: boolean
        activeCatIdAfterReject?: number
        restoredCatId?: number
        initialCatId?: number
      }
      if (r.switchedCatId !== 24) {
        return { passed: false, output: `expected switch to cat_id 24 (got ${r.switchedCatId})` }
      }
      if (typeof r.switchedTag !== 'string' || r.switchedTag.length === 0) {
        return { passed: false, output: `switched hparams missing selectedEmbodimentTag` }
      }
      if (r.switchedNumCameras !== 4) {
        return {
          passed: false,
          output: `numCameras must follow the switched embodiment, expected 4 (got ${r.switchedNumCameras})`
        }
      }
      if (!r.ranOnSwitched) {
        return { passed: false, output: 'inference on the switched embodiment did not succeed' }
      }
      if (!r.unknownTagRejected) {
        return { passed: false, output: 'unknown embodiment tag was not rejected' }
      }
      if (r.activeCatIdAfterReject !== 24) {
        return {
          passed: false,
          output: `rejected switch must leave the active embodiment in place (got cat_id ${r.activeCatIdAfterReject})`
        }
      }
      if (r.restoredCatId !== r.initialCatId) {
        return {
          passed: false,
          output: `switch back failed: restored cat_id ${r.restoredCatId} != initial ${r.initialCatId}`
        }
      }
      return { passed: true }
    }
  },
  300000,
  undefined,
  'vla-groot-multi'
)

/**
 * Reading a model's hyper-parameters and checking they describe a usable model.
 *
 * The executors checked this with a JavaScript function, which cannot cross to
 * another client. As named assertions it is the same check everywhere.
 *
 * The checks are per architecture rather than shared, because the originals
 * were: GR00T reports `tokenizerMaxLength: 0` (the prompt length follows the
 * camera count, not a hparam) and so never had it in its positive-integer
 * list, pi05 pins three cameras and discrete state, and the multi-embodiment
 * GGUF asserts the selected embodiment instead of the dimensions. One shared
 * list would have to be the intersection, which is a weaker test than any of
 * them.
 */
const vlaHparamsSteps = (dependency: string, checks: Step[]): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { call: { method: 'vlaHparams', params: { modelId: '$model' }, as: 'run' } },
  { project: { from: '$run', path: 'hparams', as: 'hparams' } },
  ...checks
]

/** The backend the runtime actually has -- or null, meaning "not reported". */
const backendIsKnown: Step[] = [
  { project: { from: '$run', path: 'backendName', as: 'backend' } },
  {
    assert: {
      on: '$backend',
      named: 'valueIn',
      with: { values: ['CPU', 'Metal', 'Vulkan', 'OpenCL'], allowNull: true }
    }
  }
]

const dimensionsArePositive = (fields: string[]): Step =>
  ({ assert: { on: '$hparams', named: 'positiveIntegers', with: { fields } } }) as Step

const hparamsEqual = (expected: Record<string, unknown>): Step =>
  ({
    assert: {
      on: '$hparams',
      named: 'fieldsMatch',
      with: { fields: Object.keys(expected), expected }
    }
  }) as Step

/** Every dimension SmolVLA and pi05 report, including the tokenizer bound. */
const FULL_DIMENSIONS = [
  'chunkSize',
  'actionDim',
  'maxActionDim',
  'maxStateDim',
  'tokenizerMaxLength',
  'visionImageSize'
]

vlaHparamsShape.steps = vlaHparamsSteps('vla', [
  dimensionsArePositive(FULL_DIMENSIONS),
  ...backendIsKnown
])

vlaPi05HparamsShape.steps = vlaHparamsSteps('vla-pi05', [
  dimensionsArePositive(FULL_DIMENSIONS),
  hparamsEqual({ numCameras: 3, stateInputMode: 'discrete' }),
  ...backendIsKnown
])

vlaGrootHparamsShape.steps = vlaHparamsSteps('vla-groot', [
  // No `tokenizerMaxLength`: GR00T reports 0 for it, deliberately.
  dimensionsArePositive([
    'chunkSize',
    'actionDim',
    'maxActionDim',
    'maxStateDim',
    'visionImageSize',
    'imagePatchElems'
  ]),
  hparamsEqual({ imageInputMode: 'patches', numCameras: 2, stateInputMode: 'continuous' }),
  ...backendIsKnown
])

vlaGrootMultiHparamsShape.steps = vlaHparamsSteps('vla-groot-multi', [
  hparamsEqual({ imageInputMode: 'patches' }),
  { project: { from: '$hparams', path: 'selectedEmbodimentTag', as: 'tag' } },
  { assert: { on: '$tag', named: 'nonEmptyText' } },
  { project: { from: '$hparams', path: 'selectedEmbodimentCatId', as: 'catId' } },
  { assert: { on: '$catId', named: 'numbersInRange', with: { min: 0, max: 31, integer: true } } }
])

/**
 * Tests that feed the model generated tensors -- images, state, tokens, a
 * mask -- and check the actions that come back. The vocabulary has no way to
 * describe building those arrays, and putting a megabyte of synthetic floats
 * in a definition would not make it data in any useful sense, so they keep
 * their hand-written bodies.
 */
const VLA_SYNTHETIC_INPUTS = new Set([
  'vla-run-synthetic-shape',
  'vla-run-stats',
  'vla-invalid-img-size',
  'vla-pi05-run-synthetic-shape',
  'vla-pi05-run-stats',
  'vla-pi05-invalid-img-size',
  'vla-groot-run-synthetic-shape',
  'vla-groot-multi-set-embodiment'
])

export const vlaTests: TestDefinition[] = [
  vlaHparamsShape,
  vlaRunSyntheticShape,
  vlaRunStats,
  vlaInvalidImgSize,
  vlaPi05HparamsShape,
  vlaPi05RunSyntheticShape,
  vlaPi05RunStats,
  vlaPi05InvalidImgSize,
  vlaGrootHparamsShape,
  vlaGrootRunSyntheticShape,
  vlaGrootMultiHparamsShape,
  vlaGrootMultiSetEmbodiment
]

// The hyper-parameter bodies are assigned above, each against its own
// architecture's checks; the tensor-fed tests keep their imperative ones.

/**
 * Not runnable on the Python client yet.
 *
 * A skip rather than an `incomplete`, decided deliberately: these are the
 * definitions the step vocabulary cannot express, so they would otherwise sit
 * in the Python column as debt with no owner and no date. The reason travels
 * with the rule, which is what keeps the skip auditable -- and they become
 * runnable the moment the per-client imperative bodies are written.
 *
 * Only definitions with no declarative body are skipped; anything already
 * migrated runs on Python like everywhere else.
 */
for (const test of vlaTests) {
  if (test.steps || test.skip) continue
  test.skip = {
    reason:
      'the Python client has no body for this: it feeds the model generated tensors -- images, state, tokens, a mask -- which the step vocabulary has no way to describe, so the Python client needs a hand-written body before this can run there',
    platforms: ['desktop-python']
  }
}
