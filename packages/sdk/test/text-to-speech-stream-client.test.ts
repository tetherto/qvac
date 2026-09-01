import test from 'brittle'
import { encodeTextToSpeechFragment, textToSpeechStream } from '@/client/api/text-to-speech'
import { RequestValidationFailedError } from '@/utils/errors-client'

async function captureValidationError(params: Parameters<typeof textToSpeechStream>[0]) {
  try {
    await textToSpeechStream(params)
    return undefined
  } catch (error) {
    return error
  }
}

test('textToSpeechStream validates emotions before opening the RPC', async (t) => {
  const error = await captureValidationError({
    modelId: 'parler',
    emotion: 'angry'
  } as never)

  t.ok(error instanceof RequestValidationFailedError)
  t.ok((error as Error).message.includes('emotion'))
})

test('textToSpeechStream validates description conflicts before opening the RPC', async (t) => {
  const error = await captureValidationError({
    modelId: 'parler',
    description: 'A calm voice.',
    emotion: 'happy'
  })

  t.ok(error instanceof RequestValidationFailedError)
  t.ok((error as Error).message.includes('emotion'))
})

test('textToSpeechStream encodes string fragments without Buffer', (t) => {
  const encoded = encodeTextToSpeechFragment('Parler 🎙️')

  t.ok(encoded instanceof Uint8Array)
  t.alike(Array.from(encoded), Array.from(new TextEncoder().encode('Parler 🎙️')))
})

test('textToSpeechStream preserves Uint8Array fragments', (t) => {
  const fragment = new Uint8Array([80, 97, 114, 108, 101, 114])

  t.is(encodeTextToSpeechFragment(fragment), fragment)
})
