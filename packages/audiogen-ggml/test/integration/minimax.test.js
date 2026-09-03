'use strict'

const test = require('brittle')
const os = require('bare-os')
const proc = require('bare-process')
const { AudioGen, ENGINE_MINIMAX, ERR_CODES } = require('@qvac/audiogen-ggml')
const { runAudioGen, INTEGRATION_TIMEOUT_MS } = require('../utils/runAudioGen')

const modelDir = proc.env.AUDIOGEN_TEST_MINIMAX_MODELS_DIR
const platform = os.platform()
const shouldSkip = !modelDir || platform === 'android' || platform === 'ios'

test(
  'AudioGen (ggml): MiniMax-Music3 desktop CPU generation',
  { timeout: INTEGRATION_TIMEOUT_MS, skip: shouldSkip },
  async (t) => {
    const gen = new AudioGen({
      engine: ENGINE_MINIMAX,
      files: { modelDir },
      config: { threads: 4 }
    })
    await gen.load()
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'A short warm piano note.',
      opts: {
        lyrics: '[Instrumental]',
        maxFrames: 1,
        seed: 7,
        inferenceSteps: 1,
        cfgScale: 1.7
      }
    })

    t.ok(data.sampleCount > 0, 'MiniMax produced audio')
    t.is(data.channels, 2, 'MiniMax produced stereo output')
    t.is(data.sampleRate, 44100, 'MiniMax produced 44.1 kHz output')
    t.ok(data.stages.includes('ar'), 'MiniMax reported autoregressive progress')
    t.ok(data.stages.includes('flow'), 'MiniMax reported flow progress')
    t.is(data.stats.backendDevice, 0, 'MiniMax used the CPU')
    t.is(data.stats.backendId, 0, 'MiniMax reported the CPU backend')

    const cancelledResponse = await gen.run('A longer orchestral build.', {
      maxFrames: 32,
      seed: 11
    })
    await gen.cancel()
    try {
      await cancelledResponse.await()
      t.fail('MiniMax cancellation must reject the response')
    } catch (error) {
      t.is(error.code, ERR_CODES.CANCELLED, 'MiniMax cancellation is terminal')
    }

    const recovered = await runAudioGen(gen, {
      caption: 'A short piano recovery note.',
      opts: {
        maxFrames: 1,
        seed: 13,
        inferenceSteps: 1
      }
    })
    t.ok(recovered.data.sampleCount > 0, 'MiniMax runs after cancellation')
  }
)
