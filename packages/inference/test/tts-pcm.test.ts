import test from 'brittle'
import Buffer from 'bare-buffer'
import { decodeTtsPcm, encodeTtsPcm, withDecodedTtsPcm } from '@/schemas/tts-pcm'

// `undefined` would select the default (global Buffer when present), so each
// path is forced: `null` takes the atob/btoa branch, `Buffer` the Buffer one.
const NO_BUFFER = null as never
const WITH_BUFFER = Buffer as never

test('int16 PCM survives the base64 round trip on both codec paths', (t) => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345, -12345, 7])
  for (const buf of [NO_BUFFER, WITH_BUFFER]) {
    const encoded = encodeTtsPcm(samples, buf)
    const decoded = decodeTtsPcm(encoded, buf)
    t.alike(Array.from(decoded), Array.from(samples))
  }
  t.is(encodeTtsPcm(new Int16Array(0), NO_BUFFER), '')
  t.is(encodeTtsPcm(new Int16Array(0), WITH_BUFFER), '')
  t.is(decodeTtsPcm('', NO_BUFFER).length, 0)
  t.is(decodeTtsPcm('', WITH_BUFFER).length, 0)
})

test('encodeTtsPcm accepts a plain number[] and the two codec paths agree', (t) => {
  const plain = [5, -5, 300, -300]
  const a = encodeTtsPcm(plain, NO_BUFFER)
  const b = encodeTtsPcm(plain, WITH_BUFFER)
  t.is(a, b, 'identical base64 from both encoders')
  t.alike(Array.from(decodeTtsPcm(a, WITH_BUFFER)), plain, 'atob-encoded, Buffer-decoded')
  t.alike(Array.from(decodeTtsPcm(b, NO_BUFFER)), plain, 'Buffer-encoded, atob-decoded')
})

test('withDecodedTtsPcm fills buffer from pcm and leaves plain frames alone', (t) => {
  const pcm = encodeTtsPcm([1, 2, 3])
  const decoded = withDecodedTtsPcm({ type: 'textToSpeech', buffer: [], pcm, done: false })
  t.alike(decoded.buffer, [1, 2, 3])
  t.is('pcm' in decoded, false)
  const plain = { type: 'textToSpeech', buffer: [9], done: true }
  t.is(withDecodedTtsPcm(plain), plain)
})

test('a 26 s frame decodes to the same samples as the JSON path', (t) => {
  const n = 1_139_589
  const samples = new Int16Array(n)
  for (let i = 0; i < n; i++) samples[i] = ((i * 7919) % 65536) - 32768
  const frame = withDecodedTtsPcm({ buffer: [], pcm: encodeTtsPcm(samples) })
  t.is(frame.buffer.length, n)
  t.is(frame.buffer[0], samples[0])
  t.is(frame.buffer[n - 1], samples[n - 1])
  t.is(frame.buffer[123456], samples[123456])
})
