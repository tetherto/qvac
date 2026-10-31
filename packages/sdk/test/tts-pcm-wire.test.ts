import test from 'brittle'
import { encodeTtsPcm, withDecodedTtsPcm, ttsResponseSchema } from '@qvac/inference/surface'

test('a pcm frame off the wire parses and decodes to the public buffer shape', (t) => {
  const samples = [0, 1, -1, 32767, -32768, 4242]
  const line = JSON.stringify({
    type: 'textToSpeech',
    buffer: [],
    pcm: encodeTtsPcm(samples),
    done: true
  })
  const frame = withDecodedTtsPcm(ttsResponseSchema.parse(JSON.parse(line)))
  t.alike(frame.buffer, samples)
  t.is('pcm' in frame, false)
  t.is(frame.done, true)
})

test('a legacy number[] frame is untouched', (t) => {
  const frame = ttsResponseSchema.parse({ type: 'textToSpeech', buffer: [3, 2, 1], done: false })
  t.is(withDecodedTtsPcm(frame), frame)
})
