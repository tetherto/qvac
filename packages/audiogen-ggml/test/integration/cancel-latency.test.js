'use strict'

// Cancellation contract for a generation that is already computing.
//
// addon.test.js covers the immediate case: cancel() straight after run(), which
// aborts before the engine is far in. This file covers the case a user actually
// hits, pressing Stop mid-generation, and pins two properties that the
// immediate case cannot observe: cancel() has to settle in bounded time, and a
// cancelled run must not produce audio.
//
// The measured latency is emitted as a comment so CI runs carry the number: a
// cancel is only honoured at the engine's next progress checkpoint, so the wall
// time between cancel() and the run unwinding scales with how long one
// checkpoint takes. On a CPU-bound run that window is where the machine keeps
// burning cores after the user asked to stop.

const test = require('brittle')
const path = require('bare-path')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')
const { loadAudioGen, NO_GPU, INTEGRATION_TIMEOUT_MS } = require('../utils/runAudioGen')
const { ERR_CODES } = require('@qvac/audiogen-ggml')

const VARIANT = 'turbo-q4'
// long enough that the LM stage is still running when the cancel lands
const DURATION_SECONDS = 30
const SEED = 4231
// Generous ceiling: this is a regression net, not a performance target. A run
// that ignores the cancel entirely renders the whole track and blows past it.
const CANCEL_SETTLE_LIMIT_MS = 180_000

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

test(
  'AudioGen (ggml): a mid-generation cancel settles and yields no audio',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const response = await gen.run('A long orchestral build.', {
      duration: DURATION_SECONDS,
      seed: SEED
    })

    // Cancel once the engine reports real sampling progress, so the run is
    // genuinely mid-flight rather than still setting up.
    let cancelStartedAt = 0
    let cancelSettledAt = 0
    let pcmSamples = 0
    let ticksAfterCancel = 0

    for await (const item of response.iterate()) {
      if (item && item.progress) {
        if (cancelStartedAt) {
          ticksAfterCancel += 1
          continue
        }
        if (item.progress.stage === 'lm' && item.progress.step > 0) {
          cancelStartedAt = Date.now()
          await gen.cancel()
          cancelSettledAt = Date.now()
        }
        continue
      }
      if (item && item.outputArray) pcmSamples += item.outputArray.length
    }

    t.ok(cancelStartedAt > 0, 'the run reached the sampling stage before being cancelled')

    const settleMs = cancelSettledAt - cancelStartedAt
    t.comment(`cancel() settled in ${settleMs}ms, ${ticksAfterCancel} progress ticks followed`)
    t.ok(
      settleMs < CANCEL_SETTLE_LIMIT_MS,
      `cancel() settles within ${CANCEL_SETTLE_LIMIT_MS}ms (took ${settleMs}ms)`
    )

    t.is(pcmSamples, 0, 'a cancelled run emits no audio')

    try {
      await response.await()
      t.fail('a cancelled response must reject')
    } catch (error) {
      t.is(error.code, ERR_CODES.CANCELLED, 'the cancelled run rejects as cancelled')
    }
  }
)
