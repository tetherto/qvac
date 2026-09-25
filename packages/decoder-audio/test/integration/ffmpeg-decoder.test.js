'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const { loadDecoder, runDecoder } = require('../helpers/ffmpeg-decoder-helper')
const { isMobile, getAssetPath } = require('./utils')

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
