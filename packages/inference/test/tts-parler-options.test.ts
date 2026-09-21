import test from 'brittle'
import { ttsRequestSchema } from '@/schemas/text-to-speech'
import {
  assertParlerJobOptionsSupported,
  getParlerJobOptions
} from '@/plugins/builtin/tts-ggml/ops/parler-options'
import { PluginRequestValidationFailedError } from '@/errors/index'

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

test('per-call conditioning options are rejected for Audio8 models', (t) => {
  const request = ttsRequestSchema.parse({
    type: 'textToSpeech',
    modelId: 'audio8',
    text: 'Hello.',
    emotion: 'happy'
  })
  const options = getParlerJobOptions(request)

  try {
    assertParlerJobOptionsSupported({ getEngineType: () => 'audio8' }, options, 'textToSpeech')
    t.fail('expected conditioning options to be rejected for Audio8')
  } catch (error) {
    t.ok(error instanceof PluginRequestValidationFailedError)
  }
})

test('a per-call emotion outside CosyVoice3 vocabulary is rejected by the SDK', (t) => {
  // The request schema validates `emotion` against Parler's 12 values because a
  // request carries only an opaque modelId. Once the engine is known, the eight
  // CosyVoice3 has no trained instruction for must be rejected here rather than
  // reaching the addon as a raw throw.
  for (const emotion of ['surprise', 'fear', 'news']) {
    const request = ttsRequestSchema.parse({
      type: 'textToSpeech',
      modelId: 'cosyvoice3',
      text: 'Hello.',
      emotion
    })

    try {
      assertParlerJobOptionsSupported(
        { getEngineType: () => 'cosyvoice3' },
        getParlerJobOptions(request),
        'textToSpeech'
      )
      t.fail(`expected emotion "${emotion}" to be rejected for CosyVoice3`)
    } catch (error) {
      t.ok(error instanceof PluginRequestValidationFailedError)
    }
  }
})

test('every CosyVoice3 emotion stays accepted per call', (t) => {
  for (const emotion of ['anger', 'happy', 'neutral', 'sad']) {
    const request = ttsRequestSchema.parse({
      type: 'textToSpeech',
      modelId: 'cosyvoice3',
      text: 'Hello.',
      emotion
    })

    t.execution(() =>
      assertParlerJobOptionsSupported(
        { getEngineType: () => 'cosyvoice3' },
        getParlerJobOptions(request),
        'textToSpeech'
      )
    )
  }
})
