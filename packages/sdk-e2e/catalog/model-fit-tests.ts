import type { TestDefinition } from '@qvac/test-suite'

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
function assessCase(family: string, dep: string, measured: boolean): TestDefinition {
  return {
    testId: `model-fit-${family}`,
    params: { dep, measured },
    expectation: { validation: 'type', expectedType: 'string' },
    suites: ['smoke'],
    // The stub comes off the registry, so one unresponsive peer decides the
    // outcome.
    retryOnFailure: true,
    metadata: { category: 'model-fit', dependency: 'none', estimatedDurationMs: 20000 }
  }
}

/** The fit check the load itself ran, read back off the resident model. */
function probeCase(family: string, dep: string, measured: boolean): TestDefinition {
  return {
    testId: `model-fit-probe-${family}`,
    params: { dep, measured },
    expectation: { validation: 'type', expectedType: 'string' },
    metadata: { category: 'model-fit', dependency: dep, estimatedDurationMs: 15000 }
  }
}

export const modelFitLlm = assessCase('llm', 'llm', true)
export const modelFitEmbeddings = assessCase('embeddings', 'embeddings', true)
export const modelFitParakeet = assessCase('parakeet', 'parakeet-tdt', true)
export const modelFitAudiogen = assessCase('audiogen', 'audiogen-turbo', true)
export const modelFitDiffusion = assessCase('diffusion', 'diffusion', true)
export const modelFitOcr = assessCase('ocr', 'ocr', true)
export const modelFitTts = assessCase('tts-chatterbox', 'tts-chatterbox', true)
export const modelFitWhisper = assessCase('whisper', 'whisper', true)
export const modelFitBci = assessCase('bci', 'bci', true)
export const modelFitTranslation = assessCase('translation', 'bergamot-en-fr', false)

export const modelFitProbeLlm = probeCase('llm', 'llm', true)
export const modelFitProbeEmbeddings = probeCase('embeddings', 'embeddings', true)
export const modelFitProbeParakeet = probeCase('parakeet', 'parakeet-tdt', true)
export const modelFitProbeWhisper = probeCase('whisper', 'whisper', true)
export const modelFitProbeBci = probeCase('bci', 'bci', true)
export const modelFitProbeTts = probeCase('tts-chatterbox', 'tts-chatterbox', true)
export const modelFitProbeAudiogen = probeCase('audiogen', 'audiogen-turbo', true)
export const modelFitProbeDiffusion = probeCase('diffusion', 'diffusion', true)
export const modelFitProbeDiffusionEsrgan = probeCase(
  'diffusion-esrgan',
  'diffusion-esrgan-fit-probe',
  true
)
export const modelFitProbeUpscaler = probeCase('upscaler', 'upscaler', true)
export const modelFitProbeOcr = probeCase('ocr', 'ocr', true)
export const modelFitProbeTranslation = probeCase('translation', 'bergamot-en-fr', true)

/**
 * Two measured engines assessed as one set, so their rows from two addons are
 * pooled together: a device both use is one pool, and the set reaches a verdict.
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
  modelFitTts,
  modelFitAudiogen,
  modelFitDiffusion,
  modelFitOcr,
  modelFitWhisper,
  modelFitBci,
  modelFitTranslation
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
  modelFitProbeTranslation
]

export const modelFitTests = [...modelFitAssessTests, modelFitTogether, ...modelFitProbeTests]
