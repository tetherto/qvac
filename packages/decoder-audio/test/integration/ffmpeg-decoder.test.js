'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const { loadDecoder, runDecoder } = require('../helpers/ffmpeg-decoder-helper')
const { isMobile, getAssetPath } = require('./utils')
const { FFmpegDecoder } = require('../..')

function sampleMp3() {
  return isMobile
    ? getAssetPath('sample_mp3.mp3')
    : path.join(__dirname, '../../example/sample.mp3')
}

test('FFmpegDecoder - rejects invalid decoded byte limits', async (t) => {
  for (const maxDecodedBytes of [0, 1.5]) {
    const decoder = new FFmpegDecoder({ config: { maxDecodedBytes } })
    try {
      await decoder.load()
      t.fail('invalid limit should be rejected')
    } catch (error) {
      t.ok(error instanceof RangeError, 'invalid limit rejects with RangeError')
    }
  }
})

test('FFmpegDecoder - streaming iterator yields PCM without retaining it', async (t) => {
  const decoder = await loadDecoder()
  try {
    const response = decoder.run(fs.createReadStream(sampleMp3()), { retainOutput: false })
    let bytes = 0
    for await (const { outputArray } of response.iterate()) bytes += outputArray.length
    t.ok(bytes > 0, 'iterator received decoded PCM')
    t.alike(await response.await(), [], 'response did not retain PCM')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - slow iterator bounds queued PCM', { timeout: 10000 }, async (t) => {
  const decoder = await loadDecoder()
  let secondChunk
  const secondChunkReceived = new Promise((resolve) => {
    secondChunk = resolve
  })
  try {
    const response = decoder.run(fs.createReadStream(sampleMp3()), { retainOutput: false })
    let emitted = 0
    response.onUpdate(() => {
      emitted++
      if (emitted === 2) secondChunk()
    })
    const iterator = response.iterate()
    const first = await iterator.next()
    t.ok(!first.done, 'iterator received the first chunk')
    await t.exception(() => response.iterate().next(), /Only one streaming iterator/)
    await secondChunkReceived
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.is(emitted, 2, 'decoding paused with one queued chunk')
    let consumedBytes = first.value.outputArray.length
    for await (const { outputArray } of iterator) consumedBytes += outputArray.length
    t.ok(emitted > 2, 'decoding resumed after the iterator consumed the queued chunk')
    t.is(consumedBytes, response.stats.outputBytes, 'iterator consumed every emitted byte')
    t.alike(await response.await(), [], 'response did not retain output')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - cancellation interrupts a paused consumer', { timeout: 10000 }, async (t) => {
  const decoder = await loadDecoder()
  let firstChunk
  const firstChunkReceived = new Promise((resolve) => {
    firstChunk = resolve
  })
  try {
    const response = decoder.run(fs.createReadStream(sampleMp3()), {
      retainOutput: false,
      waitForConsumer: () => new Promise(() => {})
    })
    response.onError(() => {})
    response.onUpdate(firstChunk)
    await firstChunkReceived
    await response.cancel()
    await t.exception(() => response.await(), /JOB_CANCELLED/)
  } finally {
    await decoder.unload()
  }
})

test(
  'FFmpegDecoder - overlapping runs keep output and stats separate',
  { timeout: 10000 },
  async (t) => {
    const decoder = await loadDecoder()
    let firstChunk
    const firstChunkReceived = new Promise((resolve) => {
      firstChunk = resolve
    })
    let releaseConsumer
    const consumerReady = new Promise((resolve) => {
      releaseConsumer = resolve
    })
    let releaseSecondConsumer
    const secondConsumerReady = new Promise((resolve) => {
      releaseSecondConsumer = resolve
    })
    let secondChunk
    const secondChunkReceived = new Promise((resolve) => {
      secondChunk = resolve
    })
    try {
      const first = decoder.run(fs.createReadStream(sampleMp3()), {
        retainOutput: false,
        waitForConsumer: () => consumerReady
      })
      let firstBytes = 0
      first.onError(() => {})
      first.onUpdate(({ outputArray }) => {
        firstBytes += outputArray.length
        firstChunk()
      })
      await firstChunkReceived
      const second = decoder.run(fs.createReadStream(sampleMp3()), {
        retainOutput: false,
        waitForConsumer: () => secondConsumerReady
      })
      releaseConsumer()
      let secondBytes = 0
      second.onUpdate(({ outputArray }) => {
        secondBytes += outputArray.length
        secondChunk()
      })
      await t.exception(() => first.await(), /Stale job replaced by new run/)
      await secondChunkReceived
      t.is(decoder._activeRun?.response, second, 'older run did not clear the active run')
      releaseSecondConsumer()
      await second.await()
      t.is(decoder._activeRun, null, 'completed run was released')
      t.is(firstBytes, first.stats.outputBytes, 'first stats count only first output')
      t.is(secondBytes, second.stats.outputBytes, 'second stats count only second output')
      t.ok(secondBytes > firstBytes, 'second run received its own decoded output')
    } finally {
      releaseConsumer()
      releaseSecondConsumer()
      await decoder.unload()
    }
  }
)

test('FFmpegDecoder - lifecycle and decoding', async (t) => {
  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    // On mobile, use testAssets; on desktop, use example folder
    const sampleFile = isMobile
      ? getAssetPath('sample_mp3.mp3')
      : path.join(__dirname, '../../example/sample.ogg')

    const result = await runDecoder(
      decoder,
      sampleFile,
      {
        minBytes: 100000, // At least 100KB of decoded audio
        minDurationMs: 1000 // At least 1 second of audio
      },
      {
        audioFormat: 's16le',
        sampleRate: 16000,
        saveRaw: false
      }
    )

    t.ok(result.passed, result.output)
    t.ok(result.data.totalBytes > 0, 'received audio data')
    t.ok(result.data.chunksReceived > 0, 'received audio chunks')
  } finally {
    await decoder.unload()
    // Give time for handles to close
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

test('FFmpegDecoder - rejects decoded audio beyond the configured limit', async (t) => {
  const decoder = await loadDecoder({ maxDecodedBytes: 1024 })
  const sampleFile = isMobile
    ? getAssetPath('sample_mp3.mp3')
    : path.join(__dirname, '../../example/sample.mp3')

  try {
    const response = decoder.run(fs.createReadStream(sampleFile), { retainOutput: false })
    response.onError(() => {})
    await t.exception(
      async () => await response.await(),
      /Decoded audio exceeds the configured byte limit/
    )
    t.ok(response.stats.outputBytes <= 1024, 'the decoder stopped within the limit')
    t.is(decoder._activeRun, null, 'failed run was released')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - streaming response does not retain PCM chunks', async (t) => {
  const decoder = await loadDecoder()
  const sampleFile = isMobile
    ? getAssetPath('sample_mp3.mp3')
    : path.join(__dirname, '../../example/sample.mp3')

  try {
    const response = decoder.run(fs.createReadStream(sampleFile), { retainOutput: false })
    let outputBytes = 0
    response.onUpdate(({ outputArray }) => {
      outputBytes += outputArray.length
    })
    const result = await response.await()
    t.ok(outputBytes > 0, 'PCM chunks were emitted')
    t.alike(result, [], 'PCM chunks were not retained in the response')
    t.is(decoder._activeRun, null, 'completed streaming run was released')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - releases a completed retained response', async (t) => {
  const decoder = await loadDecoder()
  try {
    const response = decoder.run(fs.createReadStream(sampleMp3()))
    const output = await response.await()
    t.ok(output.length > 0, 'default response retained PCM chunks')
    t.is(decoder._activeRun, null, 'completed run was released')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - waits for a streaming consumer before decoding more frames', async (t) => {
  const decoder = await loadDecoder()
  const sampleFile = isMobile
    ? getAssetPath('sample_mp3.mp3')
    : path.join(__dirname, '../../example/sample.mp3')
  let releaseConsumer
  const consumerReady = new Promise((resolve) => {
    releaseConsumer = resolve
  })
  let firstChunk
  const firstChunkReceived = new Promise((resolve) => {
    firstChunk = resolve
  })
  let received = 0
  let firstWait = true

  try {
    const response = decoder.run(fs.createReadStream(sampleFile), {
      retainOutput: false,
      waitForConsumer: () => {
        if (!firstWait) return Promise.resolve()
        firstWait = false
        return consumerReady
      }
    })
    response.onUpdate(() => {
      received++
      firstChunk()
    })
    await firstChunkReceived
    await Promise.resolve()
    t.is(received, 1, 'decoding paused after the first chunk')
    releaseConsumer()
    await response.await()
    t.ok(received > 1, 'decoding resumed after the consumer became ready')
  } finally {
    releaseConsumer()
    await decoder.unload()
  }
})

test('FFmpegDecoder - decodes multiple audio formats', async (t) => {
  // On mobile, test formats available in testAssets (ogg not supported by Expo's asset pipeline)
  // On desktop, test all formats including ogg
  const formats = isMobile ? ['mp3', 'wav', 'm4a'] : ['mp3', 'wav', 'ogg', 'm4a']

  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    for (const format of formats) {
      const sampleFile = isMobile
        ? getAssetPath(`sample_${format}.${format}`)
        : path.join(__dirname, `../../example/sample.${format}`)

      const result = await runDecoder(
        decoder,
        sampleFile,
        {
          minBytes: 100000, // At least 100KB of decoded audio
          minDurationMs: 1000 // At least 1 second of audio
        },
        {
          audioFormat: 's16le',
          sampleRate: 16000,
          saveRaw: false
        }
      )

      t.ok(result.passed, `decoded ${format}: ${result.output}`)
      t.ok(result.data.totalBytes > 0, `${format} produced audio data`)
      t.ok(result.data.chunksReceived > 0, `${format} received chunks`)
    }
  } finally {
    await decoder.unload()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

// Skip this test on mobile as it creates temp files in __dirname which may not be writable
test('FFmpegDecoder - handles corrupted file', { skip: isMobile }, async (t) => {
  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    // Create temporary corrupt file
    const corruptFile = path.join(__dirname, 'corrupt.mp3')
    fs.writeFileSync(corruptFile, 'This is not audio data')

    t.teardown(() => {
      if (fs.existsSync(corruptFile)) {
        fs.unlinkSync(corruptFile)
      }
    })

    const audioStream = fs.createReadStream(corruptFile)
    const response = await decoder.run(audioStream)

    response.onError(() => {}) // Capture expected error

    try {
      await response.await()
      t.fail('Should have failed with corrupted file')
    } catch (err) {
      t.pass('Correctly failed with corrupted file')
    }
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - returns runtime stats', async (t) => {
  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    const sampleFile = isMobile
      ? getAssetPath('sample_mp3.mp3')
      : path.join(__dirname, '../../example/sample.mp3')

    const audioStream = fs.createReadStream(sampleFile)
    const response = await decoder.run(audioStream)

    await response.onFinish(() => {}).await()

    const stats = response.stats
    t.ok(stats.decodeTimeMs > 0, 'decodeTimeMs recorded')
    t.ok(stats.inputBytes > 0, 'inputBytes recorded')
    t.ok(stats.outputBytes > 0, 'outputBytes recorded')
    t.ok(stats.samplesDecoded > 0, 'samplesDecoded recorded')
    t.ok(stats.codecName === 'mp3', 'codecName is mp3')
    t.ok(stats.inputSampleRate > 0, 'inputSampleRate recorded')
    t.is(stats.outputSampleRate, 16000, 'outputSampleRate matches config')
    t.is(stats.audioFormat, 's16le', 'audioFormat matches config')
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - handles real corrupted mp3 file', async (t) => {
  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    // Use getAssetPath for mobile compatibility
    const corruptFile = isMobile
      ? getAssetPath('corrupted.mp3')
      : path.join(__dirname, '../mobile/testAssets/corrupted.mp3')
    const audioStream = fs.createReadStream(corruptFile)
    const response = await decoder.run(audioStream)

    response.onError(() => {}) // Capture expected error

    try {
      await response.await()
      t.fail('Should have failed with corrupted mp3 file')
    } catch (err) {
      t.pass('Correctly failed with corrupted mp3 file')
    }
  } finally {
    await decoder.unload()
  }
})

test('FFmpegDecoder - cancel rejects response and decoder is reusable', async (t) => {
  const decoder = await loadDecoder({
    audioFormat: 's16le',
    sampleRate: 16000
  })

  try {
    const sampleFile = isMobile
      ? getAssetPath('sample_mp3.mp3')
      : path.join(__dirname, '../../example/sample.mp3')

    const audioStream = fs.createReadStream(sampleFile)
    const response = decoder.run(audioStream)
    response.onError(() => {})
    setImmediate(() => response.cancel())

    try {
      await response.await()
      t.fail('cancelled response should reject')
    } catch (err) {
      t.is(err.name, 'JOB_CANCELLED', 'rejected with JOB_CANCELLED')
    }

    const audioStream2 = fs.createReadStream(sampleFile)
    const response2 = decoder.run(audioStream2)
    await response2.onFinish(() => {}).await()
    t.ok(response2.stats.outputBytes > 0, 'second run produced output after a cancel')
  } finally {
    await decoder.unload()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
