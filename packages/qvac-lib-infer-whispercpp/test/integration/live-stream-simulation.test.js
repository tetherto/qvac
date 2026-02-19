'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const { Readable } = require('streamx')

const TranscriptionWhispercpp = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const { ensureWhisperModel, getTestPaths, createAudioStream, isMobile } = require('./helpers.js')

function createLoader () {
  return new FakeDL({})
}

// Create a pushable Readable to simulate a live input source.
function createLiveReadable () {
  const r = new Readable({
    read (cb) { cb(null) }
  })
  return r
}

// Paces pushing chunks at a given bytes-per-second rate.
async function feedStreamLive ({ readable, filePath, chunkBytes, bytesPerSecond }) {
  const fileStream = fs.createReadStream(filePath, { highWaterMark: chunkBytes })
  const delayPerChunkMs = Math.max(1, Math.round(1000 * (chunkBytes / Math.max(1, bytesPerSecond))))
  let idx = 0
  let total = 0
  for await (const buf of fileStream) {
    // Push as Uint8Array slice to avoid using whole underlying ArrayBuffer
    const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    total += view.byteLength
    console.log(`[feed] chunk #${idx} bytes=${view.byteLength} total=${total}`) // eslint-disable-line
    readable.push(view)
    await new Promise(resolve => setTimeout(resolve, delayPerChunkMs))
    idx++
  }
  readable.push(null) // End of stream
  return { chunksProcessed: idx, totalBytes: total }
}

// Skip on mobile - requires 10min audio file (~19MB) which is too large to bundle
test('Live stream simulation using pushable Readable with model.run()', { timeout: 180000, skip: isMobile }, async (t) => {
  // Use standardized test paths from helpers
  const { modelsDir, modelPath } = getTestPaths()
  // Use the 10-minute s16le sample from examples (provided by repo)
  const audioPath = path.resolve(__dirname, '../../examples/samples/10min-16k-s16le.raw')

  const whisperResult = await ensureWhisperModel(modelPath)

  // Verify test audio exists; skip if not present in repo checkout
  if (!fs.existsSync(audioPath)) {
    console.log(` Live stream test skipped: audio file not found at ${audioPath}`) // eslint-disable-line
    t.pass('Live stream simulation skipped (10min audio not available)')
    return
  }

  const constructorArgs = {
    modelName: path.basename(modelPath),
    loader: createLoader(),
    diskPath: modelsDir
  }

  const config = {
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      suppress_nst: true,
      // the no_context = false is important because it allows maintaining the context in live transcription
      // to provide better output quality
      no_context: false
    }
  }

  let model
  try {
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()

    const liveReadable = createLiveReadable()

    // Start model run first with an "empty" stream that will be fed
    const response = await model.run(liveReadable)
    const segments = []
    let firstUpdateAt = null
    response.onUpdate((outputArr) => {
      const items = Array.isArray(outputArr) ? outputArr : [outputArr]
      // Print each segment as it arrives to verify live output delivery
      for (const seg of items) {
        if (seg && typeof seg === 'object') {
          const txt = typeof seg.text === 'string' ? seg.text : JSON.stringify(seg)
          console.log(`[onUpdate] segment:`, txt) // eslint-disable-line
        } else {
          console.log(`[onUpdate] raw:`, seg) // eslint-disable-line
        }
      }
      if (firstUpdateAt === null) firstUpdateAt = Date.now()
      segments.push(...items)
    })

    // Feed audio in pseudo real-time (accelerated) with 3-second chunks.
    // s16le@16kHz → 32000 B/s; 3s chunk = 96000 bytes.
    const chunkBytes = 96000 // ~3s per chunk at 16k s16le
    const bytesPerSecond = chunkBytes * 1000 // keep ~1ms delay per chunk for fast tests
    const feedStart = Date.now()
    const feedStats = await feedStreamLive({ readable: liveReadable, filePath: audioPath, chunkBytes, bytesPerSecond })
    const feedEnd = Date.now()

    // Wait for completion
    await response.await()

    // Timing diagnostics to understand if updates came before feed completion
    if (firstUpdateAt) {
      console.log(`[timing] first update after ${(firstUpdateAt - feedStart)} ms from start feeding`) // eslint-disable-line
      console.log(`[timing] feed duration ${(feedEnd - feedStart)} ms; time to first update vs end: ${(firstUpdateAt - feedEnd)} ms`) // eslint-disable-line
    } else {
      console.log('[timing] no onUpdate received during/after feed') // eslint-disable-line
    }

    // Asserts: el feed debe haber empujado al menos 1 chunk y >0 bytes
    t.ok(feedStats.chunksProcessed > 0, 'Se han enviado chunks al stream (chunksProcessed > 0)')
    t.ok(feedStats.totalBytes > 0, 'Se han enviado bytes al stream (totalBytes > 0)')

    // Assertions (lenient to allow placeholder/real model paths)
    if (whisperResult.isReal) {
      t.ok(segments.length >= 1, 'Se recibió al menos un segmento en onUpdate con modelo real')
    } else {
      // With placeholder, we still expect no crashes and completion
      t.pass('Live run completed (placeholder model)')
    }
  } catch (err) {
    console.error('Live stream simulation failed:', err)
    t.fail(err.message)
  } finally {
    if (model) {
      await model.destroy()
    }
  }
})

// Skip on mobile - requires 10min audio file (~19MB) which is too large to bundle
test('Live segmented loop: repeated model.run per 3s chunk (no model teardown until end)', { timeout: 180000, skip: isMobile }, async (t) => {
  // Use standardized test paths from helpers
  const { modelsDir, modelPath } = getTestPaths()
  const audioPath = path.resolve(__dirname, '../../examples/samples/10min-16k-s16le.raw')

  const whisperResult = await ensureWhisperModel(modelPath)

  if (!fs.existsSync(audioPath)) {
    console.log(` Segmented-live test skipped: audio file not found at ${audioPath}`) // eslint-disable-line
    t.pass('Segmented-live skipped (audio not available)')
    return
  }

  const constructorArgs = {
    modelName: path.basename(modelPath),
    loader: createLoader(),
    diskPath: modelsDir
  }

  const config = {
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      suppress_nst: true
    }
  }

  let model
  try {
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()

    // 3-second chunks (s16le@16kHz → 96000 bytes per chunk)
    const chunkBytes = 96000
    const fileStream = fs.createReadStream(audioPath, { highWaterMark: chunkBytes })

    let idx = 0
    const MAX_CHUNKS = 5 // keep test fast; adjust as needed
    const allSegments = []
    let runsCompleted = 0
    let updatesCount = 0

    for await (const buf of fileStream) {
      // Use createAudioStream from helpers - it handles Buffer/Uint8Array inputs correctly
      // Create a proper Uint8Array view to avoid byteOffset issues
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      const chunkReadable = createAudioStream(view)

      console.log(`[segmented] running chunk #${idx} size=${view.byteLength}`) // eslint-disable-line
      const response = await model.run(chunkReadable)
      response.onUpdate((outputArr) => {
        const items = Array.isArray(outputArr) ? outputArr : [outputArr]
        for (const seg of items) {
          const txt = seg && typeof seg.text === 'string' ? seg.text : JSON.stringify(seg)
          console.log(`[segmented:onUpdate] #${idx} ->`, txt) // eslint-disable-line
        }
        allSegments.push(...items)
        updatesCount += items.length
      })
      await response.await()
      runsCompleted++

      idx++
      if (idx >= MAX_CHUNKS) break
    }

    // Asserts básicos del bucle segmentado
    t.is(runsCompleted, idx, 'Each model.run() per chunk must complete (runsCompleted == idx)')
    t.ok(idx > 0, 'At least one chunk should have been processed in segmented mode (idx > 0)')

    if (whisperResult.isReal) {
      t.ok(updatesCount >= 1, 'With real model, at least one update should be received in segmented mode')
    } else {
      t.pass('Segmented live run completed (placeholder model)')
    }
  } catch (err) {
    console.error('Segmented live simulation failed:', err)
    t.fail(err.message)
  } finally {
    if (model) {
      await model.destroy()
    }
  }
})
