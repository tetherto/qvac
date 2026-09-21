'use strict'

const test = require('brittle')
const os = require('bare-os')
const { AudioGenInterface } = require('../../audiogen.js')
const binding = require('../../binding.js')

const platform = os.platform()
const shouldSkip = platform === 'android' || platform === 'ios'

function createMinimaxAddon(threads) {
  return new AudioGenInterface(
    binding,
    {
      engineType: 'minimax',
      modelDir: '/models/not-loaded',
      threads,
      useGPU: false
    },
    () => {}
  )
}

function rejectThreads(t, threads, pattern) {
  t.exception(() => createMinimaxAddon(threads), pattern)
}

test(
  'AudioGen native MiniMax bridge rejects unsafe numeric casts',
  { skip: shouldSkip },
  async (t) => {
    rejectThreads(t, Number.NaN, /threads.*finite int32/)
    rejectThreads(t, Number.POSITIVE_INFINITY, /threads.*finite int32/)
    rejectThreads(t, 1.5, /threads.*finite int32/)
    rejectThreads(t, 2147483648, /threads.*finite int32/)
    rejectThreads(t, '4 trailing', /threads.*finite int32/)
    rejectThreads(t, -1, /threads.*non-negative/)

    const addon = createMinimaxAddon(0)
    t.teardown(() => addon.destroyInstance())

    await t.exception(
      () =>
        addon.runJob({
          type: 'text',
          input: 'test',
          maxFrames: Number.MAX_VALUE
        }),
      /maxFrames must be a safe integer/
    )
    await t.exception(
      () =>
        addon.runJob({
          type: 'text',
          input: 'test',
          inferenceSteps: 1001
        }),
      /inferenceSteps must be between 0 and 1000/
    )
    await t.exception(
      () =>
        addon.runJob({
          type: 'text',
          input: 'test',
          cfgScale: Number.MAX_VALUE
        }),
      /cfgScale must be 0 or a positive float32 value/
    )
  }
)
