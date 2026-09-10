'use strict'
const test = require('brittle')
const TTSGgml = require('../../index')
const process = require('bare-process')
global.process = process
const bundle = process.env.QVAC_POCKET_MODEL_DIR
const text = 'Hello! We can generate speech with Fabric.'

// Opt in with QVAC_POCKET_MODEL_DIR pointing at the converted four-file bundle.
module.exports = test(
  'Pocket native addon streams, cancels, recovers and resamples on reload',
  { skip: !bundle },
  async (t) => {
    const model = new TTSGgml({
      engine: 'pocket',
      files: { modelDir: bundle },
      opts: { stats: true }
    })
    try {
      await model.load()
      const run = async (rate) => {
        const response = await model.run({ input: text })
        const pcm = []
        const indices = []
        let last = 0
        for await (const chunk of response.iterate()) {
          t.is(chunk.sampleRate, rate)
          indices.push(chunk.chunkIndex)
          pcm.push(...chunk.outputArray)
          if (chunk.isLast) {
            last++
            t.is(chunk.outputArray.length, 0)
          }
        }
        t.is(last, 1)
        t.alike(
          indices,
          indices.map((_, i) => i)
        )
        t.is(pcm.length, response.stats.totalSamples)
        t.ok(pcm.some((x) => x !== 0))
        t.ok(response.stats.firstAudioMs > 0)
        return pcm
      }
      const original = await run(24000)
      if (process.env.QVAC_POCKET_AUDIO_OUTPUT) {
        require('../utils/wav-helper').createWav(
          new Int16Array(original),
          24000,
          process.env.QVAC_POCKET_AUDIO_OUTPUT
        )
      }
      const response = await model.run({ input: text.repeat(5) })
      let cancelPromise
      const outcomePromise = response.await().then(
        () => ({ completed: true }),
        (error) => ({ error })
      )
      response.onUpdate((chunk) => {
        if (!cancelPromise && chunk.outputArray.length) {
          cancelPromise = response.cancel()
          // Attach a rejection handler immediately; await the original promise
          // below so cancellation failures still fail the integration test.
          cancelPromise.catch(() => {})
        }
      })
      const outcome = await outcomePromise
      t.ok(cancelPromise, 'requested cancellation after first PCM')
      if (cancelPromise) await cancelPromise
      t.ok(
        outcome.error && /cancel|abort/i.test(String(outcome.error)),
        'cancelled synthesis rejects instead of completing'
      )
      const recovered = await run(24000)
      t.is(recovered.length, original.length)
      t.ok(
        recovered.every((v, i) => Math.abs(v - original[i]) <= 4),
        'deterministic PCM after cancellation'
      )
      await model.reload({ outputSampleRate: 44100 })
      const resampled = await run(44100)
      t.ok(Math.abs(resampled.length / 44100 - original.length / 24000) < 1 / 44100)
      const empty = await model.run({ input: '   ' })
      await t.exception(empty.await())
      await run(44100)
    } finally {
      await model.destroy()
    }
  }
)
