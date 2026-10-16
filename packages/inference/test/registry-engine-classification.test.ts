import test from 'brittle'
import { processRegistryModel as liveModel } from '@/handlers/registry'
import { processRegistryModel as catalogModel } from '@/models/update-models/processing'
import {
  resolveCanonicalEngine,
  resolveRegistryEngine,
  ENGINE_TO_ADDON,
  LEGACY_ENGINE_TO_CANONICAL
} from '@/schemas/engine-addon-map'

function registryModel(engine: string, tags: string[] = []) {
  return {
    path: 'example/model-Q8_0.gguf',
    source: 'hf',
    engine,
    license: 'MIT',
    name: 'model',
    sizeBytes: 1,
    sha256: 'ab',
    quantization: 'Q8_0',
    params: '1B',
    tags
  } as Parameters<typeof catalogModel>[0]
}

test('live queries and generation classify canonical and legacy models identically', (t) => {
  const cases: [string, string[], string][] = [
    ...Object.keys(ENGINE_TO_ADDON).map((engine): [string, string[], string] => [
      engine,
      [],
      resolveCanonicalEngine(engine)!
    ]),
    ...Object.entries(LEGACY_ENGINE_TO_CANONICAL).map(
      ([legacy, canonical]): [string, string[], string] => [legacy, [], canonical]
    ),
    ['@qvac/asr-ggml', ['transcription', 'moss-transcribe'], 'moss-transcribe'],
    ['whispercpp-transcription', ['moss-transcribe'], 'whispercpp-transcription']
  ]
  for (const [engine, tags, expected] of cases) {
    const row = registryModel(engine, tags)
    const live = liveModel(row)
    const generated = catalogModel(row)
    t.is(live?.engine, expected, engine)
    t.is(generated?.engine, expected, engine)
    t.is(live?.addon, generated?.addon, engine)
  }
})

test('shared legacy packages require a recognized discriminator', (t) => {
  t.is(resolveRegistryEngine('@qvac/asr-ggml'), null)
  t.is(resolveRegistryEngine('@qvac/asr-ggml', ['transcription']), null)
  t.is(resolveRegistryEngine('@qvac/asr-ggml', ['moss-transcribe']), 'moss-transcribe')
})

test('unknown engine strings cannot resolve through object prototypes', (t) => {
  for (const engine of ['constructor', 'toString', '__proto__', 'llamacpp-completon']) {
    t.is(resolveCanonicalEngine(engine), null, engine)
    t.is(resolveRegistryEngine(engine, ['moss-transcribe']), null, engine)
  }
})
