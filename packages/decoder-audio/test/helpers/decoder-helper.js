'use strict'

const path = require('bare-path')
const fs = require('bare-fs')

function getBytesPerSample (audioFormat) {
  if (audioFormat === 'f32le') {
    return 4
  } else if (audioFormat === 's16le') {
    return 2
  } else if (audioFormat === 'encoded') {
    // For encoded formats, assume s16le output (most common)
    return 2
  }
  // Default for s16le
  return 2
}

function validateExpectations (expectation, sampleCount, durationMs, totalBytes) {
  let passed = true
  const errors = []

  if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) {
    passed = false
    errors.push(`Expected at least ${expectation.minSamples} samples, got ${sampleCount}`)
  }

  if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) {
    passed = false
    errors.push(`Expected at most ${expectation.maxSamples} samples, got ${sampleCount}`)
  }

  if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) {
    passed = false
    errors.push(`Expected at least ${expectation.minDurationMs}ms duration, got ${durationMs.toFixed(0)}ms`)
  }

  if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) {
    passed = false
    errors.push(`Expected at most ${expectation.maxDurationMs}ms duration, got ${durationMs.toFixed(0)}ms`)
  }

  if (expectation.minBytes !== undefined && totalBytes < expectation.minBytes) {
    passed = false
    errors.push(`Expected at least ${expectation.minBytes} bytes, got ${totalBytes}`)
  }

  if (expectation.maxBytes !== undefined && totalBytes > expectation.maxBytes) {
    passed = false
    errors.push(`Expected at most ${expectation.maxBytes} bytes, got ${totalBytes}`)
  }

  return { passed, errors }
}

async function processDecoderResponse (response, audioFormat, sampleRate) {
  let outputArray = []
  let totalBytes = 0
  let chunksReceived = 0

  await response
    .onUpdate(data => {
      if (data && data.outputArray) {
        const bytes = new Uint8Array(data.outputArray)
        outputArray = outputArray.concat(Array.from(bytes))
        totalBytes += bytes.length
        chunksReceived++
      }
    })
    .onFinish(() => {})
    .await()

  const jobStats = response.stats
  const sampleCount = jobStats.samplesDecoded
  const durationMs = (sampleCount / sampleRate) * 1000

  return {
    outputArray,
    totalBytes,
    chunksReceived,
    jobStats,
    sampleCount,
    durationMs
  }
}

function buildResult (audioFilePath, outputArray, totalBytes, chunksReceived, jobStats, sampleCount, durationMs, errors, passed) {
  const stats = jobStats || null

  // Build stats info string based on available runtime stats
  let statsInfo
  if (stats && stats.decodeTimeMs !== undefined) {
    statsInfo = `decoded in ${stats.decodeTimeMs}ms, codec: ${stats.codecName || 'unknown'}`
  } else if (stats) {
    statsInfo = `duration: ${durationMs.toFixed(0)}ms (from stats)`
  } else {
    statsInfo = `duration: ${durationMs.toFixed(0)}ms (calculated)`
  }

  const fileName = path.basename(audioFilePath)
  const output = `Decoded ${sampleCount} samples (${totalBytes} bytes, ${statsInfo}) from file: "${fileName}"${errors.length > 0 ? ` - Errors: ${errors.join('; ')}` : ''}`

  return {
    output,
    passed,
    data: {
      samples: outputArray,
      sampleCount,
      totalBytes,
      durationMs,
      chunksReceived,
      stats
    }
  }
}

async function runDecoder (decoder, audioFilePath, expectation = {}, params = {}, defaultRawPath) {
  if (!decoder) {
    return {
      output: 'Error: Missing required parameter: decoder',
      passed: false
    }
  }

  if (!audioFilePath) {
    return {
      output: 'Error: Missing required parameter: audioFilePath',
      passed: false
    }
  }

  const audioFormat = params.audioFormat || decoder.config?.audioFormat || 's16le'
  const sampleRate = params.sampleRate || decoder.config?.sampleRate || 16000

  let audioStream = null
  try {
    if (!fs.existsSync(audioFilePath)) {
      return {
        output: `Error: Audio file not found: ${audioFilePath}`,
        passed: false
      }
    }

    audioStream = fs.createReadStream(audioFilePath)
    const response = await decoder.run(audioStream)

    const {
      outputArray,
      totalBytes,
      chunksReceived,
      jobStats,
      sampleCount,
      durationMs
    } = await processDecoderResponse(response, audioFormat, sampleRate)

    await new Promise(resolve => setTimeout(resolve, 500))

    const { passed, errors } = validateExpectations(expectation, sampleCount, durationMs, totalBytes)

    if (params.saveRaw !== false && outputArray.length > 0) {
      const rawPath = params.rawOutputPath || defaultRawPath

      const outputDir = path.dirname(rawPath)
      try {
        fs.mkdirSync(outputDir, { recursive: true })
      } catch (err) {
        // Directory might already exist, ignore error
      }

      fs.writeFileSync(rawPath, Buffer.from(outputArray))
    }

    return buildResult(audioFilePath, outputArray, totalBytes, chunksReceived, jobStats, sampleCount, durationMs, errors, passed)
  } catch (error) {
    return {
      output: `Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  } finally {
    if (audioStream && typeof audioStream.destroy === 'function') {
      audioStream.destroy()
    }
  }
}

module.exports = { runDecoder, getBytesPerSample, validateExpectations, processDecoderResponse, buildResult }
