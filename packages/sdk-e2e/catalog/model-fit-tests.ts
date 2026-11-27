import type { TestDefinition } from '@qvac/test-suite'

/**
 * Host OSes where an engine's fitter may answer `unknown` for this load. On
 * Apple, `@qvac/tts-ggml` 0.17.2 and `@qvac/audiogen-ggml` 0.12.1 return an
 * unsized fit (`coreml-memory-estimate-unavailable`) when a Core ML sidecar is
 * active. A measured verdict still passes there.
 */
type UnsizedOn = ('darwin' | 'ios')[]

/**
 * `assessModelFit` against the registry's weightless description of a load,
 * before any weights exist locally. Each case assesses the load the resource
 * manager would run for that dep, so the assessment and the load stay the same
 * shape.
 *
 * `measured` engines have a fitter and must reach a verdict; every other engine
 * answers `unknown`.
 *
 * `dependency: 'none'` keeps these out of the bootstrap download set: a stub is
 * tens of KB, and nothing here loads a model.
 */
function assessCase(
  family: string,
  dep: string,
  measured: boolean,
  unsizedOn?: UnsizedOn
): TestDefinition {
  return {
    testId: `model-fit-${family}`,
    params: { dep, measured, ...(unsizedOn && { unsizedOn }) },
    expectation: { validation: 'type', expectedType: 'string' },
    suites: ['smoke'],
    // The stub comes off the registry, so one unresponsive peer decides the
    // outcome.
    retryOnFailure: true,
    metadata: { category: 'model-fit', dependency: 'none', estimatedDurationMs: 20000 }
  }
}

/**
 * `assessModelFit` for an engine whose fitter reads the model files and no
 * registry description. It answers only once `loadModel` has downloaded them,
 * so the case declares its dep to have them on disk and must reach a verdict.
 */
function filesOnlyCase(family: string, dep: string): TestDefinition {
  return {
    testId: `model-fit-${family}`,
    params: { dep, measured: true },
    expectation: { validation: 'type', expectedType: 'string' },
    suites: ['smoke'],
    metadata: { category: 'model-fit', dependency: dep, estimatedDurationMs: 20000 }
  }
}

/** The fit check the load itself ran, read back off the resident model. */
function probeCase(
  family: string,
  dep: string,
  measured: boolean,
  unsizedOn?: UnsizedOn
): TestDefinition {
  return {
    testId: `model-fit-probe-${family}`,
    params: { dep, measured, ...(unsizedOn && { unsizedOn }) },
    expectation: { validation: 'type', expectedType: 'string' },
    metadata: { category: 'model-fit', dependency: dep, estimatedDurationMs: 15000 }
  }
}

export const modelFitLlm = assessCase('llm', 'llm', true)
export const modelFitEmbeddings = assessCase('embeddings', 'embeddings', true)
export const modelFitParakeet = assessCase('parakeet', 'parakeet-tdt', true)
export const modelFitAudiogen = assessCase('audiogen', 'audiogen-turbo', true, ['darwin'])
export const modelFitDiffusion = assessCase('diffusion', 'diffusion', true)
export const modelFitOcr = assessCase('ocr', 'ocr', true)

/**
 * One per voice engine: `assessFit` in `@qvac/tts-ggml` takes a different
 * request shape for each, and sizes each from its own stage checkpoints.
 */
export const modelFitTtsChatterbox = assessCase('tts-chatterbox', 'tts-chatterbox', true)
export const modelFitTtsParler = assessCase('tts-parler', 'tts-parler', true)
export const modelFitTtsCosyvoice = assessCase('tts-cosyvoice3', 'tts-cosyvoice3', true)
export const modelFitTtsAudio8 = assessCase('tts-audio8', 'tts-audio8', true, ['darwin', 'ios'])
export const modelFitTtsSupertonic = assessCase('tts-supertonic', 'tts-supertonic', true)

export const modelFitWhisper = assessCase('whisper', 'whisper', true)
export const modelFitBci = assessCase('bci', 'bci', true)
export const modelFitTranslation = filesOnlyCase('translation', 'bergamot-en-fr')
export const modelFitClassification = filesOnlyCase('classification', 'classification')
export const modelFitImageEmbedding = filesOnlyCase('image-embedding', 'image-embedding')

export const modelFitProbeLlm = probeCase('llm', 'llm', true)
export const modelFitProbeEmbeddings = probeCase('embeddings', 'embeddings', true)
export const modelFitProbeParakeet = probeCase('parakeet', 'parakeet-tdt', true)
export const modelFitProbeWhisper = probeCase('whisper', 'whisper', true)
export const modelFitProbeBci = probeCase('bci', 'bci', true)
export const modelFitProbeTts = probeCase('tts-chatterbox', 'tts-chatterbox', true)
export const modelFitProbeAudiogen = probeCase('audiogen', 'audiogen-turbo', true, ['darwin'])
export const modelFitProbeDiffusion = probeCase('diffusion', 'diffusion', true)
export const modelFitProbeDiffusionEsrgan = probeCase(
  'diffusion-esrgan',
  'diffusion-esrgan-fit-probe',
  true
)
export const modelFitProbeUpscaler = probeCase('upscaler', 'upscaler', true)
export const modelFitProbeOcr = probeCase('ocr', 'ocr', true)
export const modelFitProbeTranslation = probeCase('translation', 'bergamot-en-fr', true)
export const modelFitProbeClassification = probeCase('classification', 'classification', true)
export const modelFitProbeImageEmbedding = probeCase('image-embedding', 'image-embedding', true)

/**
 * Two measured engines assessed as one set, so their rows from two addons are
 * pooled together: a device both use is one pool, and the set reaches a verdict
 * unless one of them runs on the CPU.
 */
export const modelFitTogether: TestDefinition = {
  testId: 'model-fit-llm-and-tts',
  params: { deps: ['llm', 'tts-chatterbox'] },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  retryOnFailure: true,
  metadata: { category: 'model-fit', dependency: 'none', estimatedDurationMs: 30000 }
}

export const modelFitAssessTests = [
  modelFitLlm,
  modelFitEmbeddings,
  modelFitParakeet,
  modelFitTtsChatterbox,
  modelFitTtsParler,
  modelFitTtsCosyvoice,
  modelFitTtsAudio8,
  modelFitTtsSupertonic,
  modelFitAudiogen,
  modelFitDiffusion,
  modelFitOcr,
  modelFitWhisper,
  modelFitBci,
  modelFitTranslation,
  modelFitClassification,
  modelFitImageEmbedding
]

export const modelFitProbeTests = [
  modelFitProbeLlm,
  modelFitProbeEmbeddings,
  modelFitProbeParakeet,
  modelFitProbeWhisper,
  modelFitProbeBci,
  modelFitProbeTts,
  modelFitProbeAudiogen,
  modelFitProbeDiffusion,
  modelFitProbeDiffusionEsrgan,
  modelFitProbeUpscaler,
  modelFitProbeOcr,
  modelFitProbeTranslation,
  modelFitProbeClassification,
  modelFitProbeImageEmbedding
]

export const modelFitTests = [...modelFitAssessTests, modelFitTogether, ...modelFitProbeTests]
