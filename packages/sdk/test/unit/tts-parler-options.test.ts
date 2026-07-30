import test from 'brittle'
import { ttsRequestSchema } from '@/schemas/text-to-speech'
import {
  assertParlerJobOptionsSupported,
  getParlerJobOptions
} from '@/server/bare/plugins/tts-ggml/ops/parler-options'
import { PluginRequestValidationFailedError } from '@/utils/errors-server'

test('Parler per-call options are rejected for other TTS engines', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'supertonic',
    text: 'Hello.',
    emotion: 'happy'
  })
  const options = getParlerJobOptions(request)

  try {
    assertParlerJobOptionsSupported({ getEngineType: () => 'supertonic' }, options, 'textToSpeech')
    t.fail('expected Parler options to be rejected')
  } catch (error) {
    t.ok(error instanceof PluginRequestValidationFailedError)
    t.ok((error as Error).message.includes('only supported by Parler'))
  }
})

test('Parler per-call options are accepted for Parler models', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'parler',
    text: 'Hello.',
    voice: 'Laura'
  })

  t.execution(() =>
    assertParlerJobOptionsSupported(
      { getEngineType: () => 'parler' },
      getParlerJobOptions(request),
      'textToSpeech'
    )
  )
})

test('requests without Parler options preserve existing engine behavior', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'chatterbox',
    text: 'Hello.'
  })

  t.execution(() =>
    assertParlerJobOptionsSupported(
      { getEngineType: () => 'chatterbox' },
      getParlerJobOptions(request),
      'textToSpeech'
    )
  )
})
