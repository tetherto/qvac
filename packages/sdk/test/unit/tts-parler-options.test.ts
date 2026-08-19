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

test('per-call emotion and pace are accepted for CosyVoice3 models', (t) => {
  const emotionRequest = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'cosyvoice3',
    text: 'Hello.',
    emotion: 'happy'
  })

  t.execution(() =>
    assertParlerJobOptionsSupported(
      { getEngineType: () => 'cosyvoice3' },
      getParlerJobOptions(emotionRequest),
      'textToSpeech'
    )
  )

  const paceRequest = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'cosyvoice3',
    text: 'Hello.',
    pace: 'fast'
  })

  t.execution(() =>
    assertParlerJobOptionsSupported(
      { getEngineType: () => 'cosyvoice3' },
      getParlerJobOptions(paceRequest),
      'textToSpeech'
    )
  )
})

test('Parler-only per-call options are rejected for CosyVoice3 models', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'cosyvoice3',
    text: 'Hello.',
    voice: 'Laura',
    pitch: 'high'
  })
  const options = getParlerJobOptions(request)

  try {
    assertParlerJobOptionsSupported({ getEngineType: () => 'cosyvoice3' }, options, 'textToSpeech')
    t.fail('expected Parler-only options to be rejected')
  } catch (error) {
    t.ok(error instanceof PluginRequestValidationFailedError)
    t.ok((error as Error).message.includes('voice, pitch'))
    t.ok((error as Error).message.includes('CosyVoice3 supports emotion and pace'))
  }
})

test('CosyVoice3 rejects a per-call emotion combined with a non-moderate pace', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'cosyvoice3',
    text: 'Hello.',
    emotion: 'happy',
    pace: 'fast'
  })
  const options = getParlerJobOptions(request)

  try {
    assertParlerJobOptionsSupported({ getEngineType: () => 'cosyvoice3' }, options, 'textToSpeech')
    t.fail('expected conflicting conditioning controls to be rejected')
  } catch (error) {
    t.ok(error instanceof PluginRequestValidationFailedError)
    t.ok((error as Error).message.includes('one conditioning control per synthesis'))
  }
})

test('CosyVoice3 accepts a per-call emotion with the disengaging moderate pace', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'cosyvoice3',
    text: 'Hello.',
    emotion: 'sad',
    pace: 'moderate'
  })

  t.execution(() =>
    assertParlerJobOptionsSupported(
      { getEngineType: () => 'cosyvoice3' },
      getParlerJobOptions(request),
      'textToSpeech'
    )
  )
})
