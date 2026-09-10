import test from 'brittle'
import { ttsConfigSchema, ttsRuntimeConfigSchema } from '@/schemas/text-to-speech'
const base = {
  ttsEngine: 'pocket',
  mimiModelSrc: '/mimi.gguf',
  frontendSrc: '/frontend.json',
  voiceSrc: '/voice.gguf'
}
test('Pocket accepts bundle descriptors, defaults English and preserves unsigned seeds', (t) => {
  const parsed = ttsConfigSchema.parse({
    ...base,
    seed: 4294967295,
    temperature: 0
  })
  t.is('language' in parsed ? parsed.language : undefined, 'en')
  t.is(parsed.ttsEngine, 'pocket')
  t.is(
    ttsConfigSchema.safeParse({
      ...base,
      mimiModelSrc: { src: '/mimi.gguf', sha256Checksum: 'abc' }
    }).success,
    true
  )
  t.is(ttsRuntimeConfigSchema.safeParse({ ttsEngine: 'pocket' }).success, true)
})
test("Pocket rejects wrong engines' settings, numeric overflow and ambiguous voice sources", (t) => {
  for (const change of [
    { useGPU: true },
    { language: 'fr' },
    { seed: -1 },
    { seed: 4294967296 },
    { seed: 1.5 },
    { temperature: NaN },
    { temperature: Infinity },
    { steps: 0 },
    { nCtx: 8193 },
    { outputSampleRate: 7999 },
    { outputSampleRate: 44100.5 },
    { voice: 'F1' },
    { streamChunkTokens: 10 },
    { ttsSpeed: 1 },
    { threads: 0 },
    { maxTokens: 0 },
    { voiceSrc: undefined },
    { referenceAudioSrc: '/voice.wav' },
    { mimiModelSrc: undefined }
  ]) {
    t.is(
      ttsConfigSchema.safeParse({ ...base, ...change }).success,
      false,
      String(Object.keys(change))
    )
  }
  t.is(
    ttsConfigSchema.safeParse({
      ...base,
      voiceSrc: undefined,
      referenceAudioSrc: '/voice.wav'
    }).success,
    true
  )
})
