import test from 'brittle'
import { qvacConfigSchema } from '@/schemas/config'

test('audio decoder bundle option accepts booleans and rejects other values', (t) => {
  t.is(qvacConfigSchema.parse({ includeAudioDecoder: false }).includeAudioDecoder, false)
  t.is(qvacConfigSchema.parse({ includeAudioDecoder: true }).includeAudioDecoder, true)
  t.absent(qvacConfigSchema.safeParse({ includeAudioDecoder: 'false' }).success)
})
