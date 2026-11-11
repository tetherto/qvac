import test from 'brittle'
import {
  buildParakeetConfig,
  buildParakeetEngineConfig,
  buildParakeetReloadConfig,
  SPEAKER_ATTRIBUTION_MODEL_PATH
} from '@/plugins/builtin/asr-ggml/config'
import { parakeetPlugin } from '@/plugins/builtin/parakeet-transcription/plugin'
import { ModelLoadFailedError } from '@/errors/index'
import { ModelType, type ParakeetConfig, type ResolveContext } from '@/schemas/index'

const DIARIZER_PATH = '/cache/models/sortformer-4spk-v1.q8_0.gguf'

function resolveContext(calls: unknown[]): ResolveContext {
  return {
    modelSrc: 'parakeet-unified-en-0.6b.q8_0.gguf',
    modelType: ModelType.parakeetTranscription,
    resolveModelPath: async (src) => {
      calls.push(src)
      return DIARIZER_PATH
    }
  }
}

test('buildParakeetConfig: swaps the resolved diarization path in for the model source', (t) => {
  const config: ParakeetConfig = {
    backend: 'cpu',
    useGPU: false,
    speakerAttribution: {
      modelSrc: 'sortformer-4spk-v1.q8_0.gguf',
      mergeSameSpeaker: false,
      padSegmentMs: 250,
      minSegmentMs: undefined
    }
  }

  t.alike(buildParakeetConfig(config, { [SPEAKER_ATTRIBUTION_MODEL_PATH]: DIARIZER_PATH }), {
    backend: 'cpu',
    useGPU: false,
    speakerAttribution: { modelPath: DIARIZER_PATH, mergeSameSpeaker: false, padSegmentMs: 250 }
  })
  t.alike(
    buildParakeetEngineConfig(config, { [SPEAKER_ATTRIBUTION_MODEL_PATH]: DIARIZER_PATH }),
    {
      engine: 'parakeet',
      parakeetConfig: {
        backend: 'cpu',
        useGPU: false,
        speakerAttribution: {
          modelPath: DIARIZER_PATH,
          mergeSameSpeaker: false,
          padSegmentMs: 250
        }
      }
    },
    'the engine config carries the addon-side shape'
  )
})

test('buildParakeetConfig: a configured attribution without its resolved path is a load failure', (t) => {
  const config: ParakeetConfig = { speakerAttribution: { modelSrc: 'sortformer.gguf' } }
  t.exception(() => buildParakeetConfig(config), ModelLoadFailedError)
  t.exception(() => buildParakeetConfig(config, {}), ModelLoadFailedError)
})

test('buildParakeetConfig: a load without attribution is unchanged', (t) => {
  const config: ParakeetConfig = { backend: 'vulkan', language: 'other', prewarm: undefined }
  t.alike(buildParakeetConfig(config), { backend: 'vulkan', language: 'other' })
  t.alike(buildParakeetEngineConfig(config), {
    engine: 'parakeet',
    parakeetConfig: { backend: 'vulkan', language: 'other' }
  })
})

test('buildParakeetReloadConfig: leaves the loaded diarization model alone', (t) => {
  // A reload merges into the loaded config and has no artifacts to resolve a
  // new source with, so the attribution stays as the load set it.
  t.alike(
    buildParakeetReloadConfig({
      maxThreads: 2,
      speakerAttribution: { modelSrc: 'sortformer.gguf', mergeSameSpeaker: true }
    }),
    { parakeetConfig: { maxThreads: 2 } }
  )
})

test('parakeet resolveConfig: resolves the diarization model into an artifact', async (t) => {
  const calls: unknown[] = []
  const config: ParakeetConfig = {
    backend: 'cpu',
    speakerAttribution: { modelSrc: { src: 'pear://abc/nemotron-3-diarization.q8_0.gguf' } }
  }

  const result = await parakeetPlugin.resolveConfig!(config, resolveContext(calls))

  t.alike(
    calls,
    [{ src: 'pear://abc/nemotron-3-diarization.q8_0.gguf' }],
    'the source is resolved as given'
  )
  t.alike(result.artifacts, { [SPEAKER_ATTRIBUTION_MODEL_PATH]: DIARIZER_PATH })
  t.alike(result.config, config, 'the stored load config keeps its model source')
})

test('parakeet resolveConfig: resolves nothing extra without attribution', async (t) => {
  const calls: unknown[] = []
  const result = await parakeetPlugin.resolveConfig!({ backend: 'cpu' }, resolveContext(calls))
  t.alike(calls, [], 'no second model is resolved')
  t.alike(result, { config: { backend: 'cpu' } })
})
