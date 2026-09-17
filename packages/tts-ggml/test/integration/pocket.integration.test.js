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
      const sentenceStream = await model.runStream('Hello. Speech is ready.', {
        maxChunkScalars: 16
      })
      await sentenceStream.onUpdate(() => {}).await()
      t.ok(sentenceStream.stats.firstAudioMs > 0, 'runStream preserves native first-audio latency')
      const textStream = await model.runStreaming(
        (async function* () {
          yield 'Hello.'
          yield 'Speech is ready.'
        })(),
        { accumulateSentences: false }
      )
      await textStream.onUpdate(() => {}).await()
      t.ok(textStream.stats.firstAudioMs > 0, 'runStreaming preserves native first-audio latency')

      // Check that omitted steps match the explicit upstream/native default
      // through the complete addon path. PCM parity validates configuration,
      // not subjective quality or the absence of model-generated artifacts.
      const explicit = new TTSGgml({
        engine: 'pocket',
        files: { modelDir: bundle },
        steps: 1
      })
      try {
        await explicit.load()
        const reference = await explicit.run({ input: text })
        const pcm = []
        for await (const chunk of reference.iterate()) pcm.push(...chunk.outputArray)
        t.is(pcm.length, original.length, 'default and explicit one-step lengths match')
        t.ok(
          pcm.every((v, i) => Math.abs(v - original[i]) <= 4),
          'default native PCM matches explicit one-step synthesis'
        )
      } finally {
        await explicit.destroy()
      }
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
      await t.exception(model.reload({ referenceAudio: `${bundle}/missing-reload-test.wav` }))
      t.is(
        model.getState().weightsLoaded,
        false,
        'failed native activation leaves the model unloaded'
      )
      await t.exception(model.run({ input: text }), /not loaded/)
      await model.load()
      const restored = await run(44100)
      t.is(
        restored.length,
        resampled.length,
        'load restores the last successful sample rate and voice'
      )
      t.ok(
        restored.every((v, i) => Math.abs(v - resampled[i]) <= 4),
        'PCM recovers after failed reload'
      )
      const empty = await model.run({ input: '   ' })
      await t.exception(empty.await())
      await run(44100)
      // Verify the packaged native dependency includes the merged EOS-tail
      // fix: the old token-only budget threw after emitting partial audio.
      await model.reload({ outputSampleRate: 24000, framesAfterEos: 100, eosThreshold: -1e30 })
      const tail = await model.run({ input: 'Hi.' })
      let tailSamples = 0
      let tailCompleted = 0
      for await (const chunk of tail.iterate()) {
        tailSamples += chunk.outputArray.length
        if (chunk.isLast) tailCompleted++
      }
      t.is(tailCompleted, 1, 'explicit EOS tail completes normally')
      t.is(tailSamples, 100 * 1920, 'all 100 EOS-tail frames are delivered')
    } finally {
      await model.destroy()
    }
  }
)
