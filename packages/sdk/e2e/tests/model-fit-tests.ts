import type { TestDefinition } from '@qvac/test-suite'

/**
 * `assessModelFit` against the registry's weightless description of a load,
 * before any weights exist locally. Each case assesses the load the resource
 * manager would run for that dep, so the assessment and the load stay the same
 * shape.
 *
 * `dependency: 'none'` keeps these out of the bootstrap download set: a stub is
 * tens of KB, and nothing here loads a model.
 */
function assessCase(
  family: string,
  dep: string,
  evidence: 'native-fit' | 'computed-only'
): TestDefinition {
  return {
    testId: `model-fit-${family}`,
    params: { dep, evidence },
    expectation: { validation: 'type', expectedType: 'string' },
    suites: ['smoke'],
    metadata: { category: 'model-fit', dependency: 'none', estimatedDurationMs: 20000 }
  }
}

/**
 * The projection the load itself ran, read back off the resident model. The
 * load having succeeded is what makes the verdict checkable.
 */
function probeCase(family: string, dep: string, engine: string): TestDefinition {
  return {
    testId: `model-fit-probe-${family}`,
    params: { dep, engine },
    expectation: { validation: 'type', expectedType: 'string' },
    metadata: { category: 'model-fit', dependency: dep, estimatedDurationMs: 15000 }
  }
}

export const modelFitLlm = assessCase('llm', 'llm', 'native-fit')
export const modelFitEmbeddings = assessCase('embeddings', 'embeddings', 'native-fit')
export const modelFitParakeet = assessCase('parakeet', 'parakeet-tdt', 'native-fit')
export const modelFitAudiogen = assessCase('audiogen', 'audiogen-turbo', 'native-fit')
export const modelFitDiffusion = assessCase('diffusion', 'diffusion', 'native-fit')

/**
 * One per voice engine: `assessFit` in `@qvac/tts-ggml` takes a different
 * request shape for each, and sizes each from its own stage checkpoints.
 */
export const modelFitTtsChatterbox = assessCase('tts-chatterbox', 'tts-chatterbox', 'native-fit')
export const modelFitTtsParler = assessCase('tts-parler', 'tts-parler', 'native-fit')
export const modelFitTtsCosyvoice = assessCase('tts-cosyvoice3', 'tts-cosyvoice3', 'native-fit')
export const modelFitTtsAudio8 = assessCase('tts-audio8', 'tts-audio8', 'native-fit')
export const modelFitTtsSupertonic = assessCase('tts-supertonic', 'tts-supertonic', 'native-fit')

/**
 * Whisper and BCI ship as ggml `.bin`, which carries no separable header, so
 * the registry can hold no weightless description of them. Their assessment
 * rests on the computed floor, which can refuse a model but never confirm one.
 * The engine fitters still answer for them at load time — see the probe cases.
 */
export const modelFitWhisper = assessCase('whisper', 'whisper', 'computed-only')
export const modelFitBci = assessCase('bci', 'bci', 'computed-only')

export const modelFitProbeLlm = probeCase('llm', 'llm', 'llm-llamacpp')
export const modelFitProbeEmbeddings = probeCase('embeddings', 'embeddings', 'embed-llamacpp')
export const modelFitProbeParakeet = probeCase('parakeet', 'parakeet-tdt', 'asr-ggml')
export const modelFitProbeWhisper = probeCase('whisper', 'whisper', 'asr-ggml')
export const modelFitProbeBci = probeCase('bci', 'bci', 'bci-whispercpp')
export const modelFitProbeTts = probeCase('tts-chatterbox', 'tts-chatterbox', 'tts-ggml')
export const modelFitProbeAudiogen = probeCase('audiogen', 'audiogen-turbo', 'audiogen-ggml')
export const modelFitProbeDiffusion = probeCase('diffusion', 'diffusion', 'diffusion-cpp')

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
  modelFitWhisper,
  modelFitBci
]

export const modelFitProbeTests = [
  modelFitProbeLlm,
  modelFitProbeEmbeddings,
  modelFitProbeParakeet,
  modelFitProbeWhisper,
  modelFitProbeBci,
  modelFitProbeTts,
  modelFitProbeAudiogen,
  modelFitProbeDiffusion
]

export const modelFitTests = [...modelFitAssessTests, ...modelFitProbeTests]
