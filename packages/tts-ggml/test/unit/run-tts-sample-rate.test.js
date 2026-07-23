'use strict'

const test = require('brittle')
const { runTTS } = require('../utils/runTTS')

function fakeModel(sampleRate) {
  return {
    run() {
      return {
        stats: null,
        onUpdate(callback) {
          callback({
            outputArray: Int16Array.from([100, -100, 200, -200]),
            sampleRate
          })
          return this
        },
        await() {
          return Promise.resolve()
        }
      }
    }
  }
}

function wavSampleRate(wavBuffer) {
  return wavBuffer[24] | (wavBuffer[25] << 8) | (wavBuffer[26] << 16) | (wavBuffer[27] << 24)
}

test('runTTS writes the reported output sample rate into the WAV header', async (t) => {
  const result = await runTTS(
    fakeModel(48000),
    { text: 'enhanced output' },
    {},
    { sampleRate: 24000 }
  )

  t.ok(result.passed)
  t.is(result.data.sampleRate, 48000)
  t.is(result.data.reportedSampleRate, 48000)
  t.is(wavSampleRate(result.data.wavBuffer), 48000)
})

test('runTTS falls back to the engine sample rate when none is reported', async (t) => {
  const result = await runTTS(fakeModel(null), { text: 'native output' }, {}, { sampleRate: 24000 })

  t.ok(result.passed)
  t.is(result.data.sampleRate, 24000)
  t.is(wavSampleRate(result.data.wavBuffer), 24000)
})
