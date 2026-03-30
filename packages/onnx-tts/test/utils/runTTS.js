'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const { createWavBuffer } = require('./wav-helper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function runTTS (model, params, expectation = {}, options = {}) {
  const sampleRate = options.sampleRate || 24000
  const engineTag = options.engineTag || ''
  const tag = engineTag ? `[${engineTag}] ` : ''

  if (!model) {
    return {
      output: `${tag}Error: Missing required parameter: model`,
      passed: false
    }
  }

  if (!params || !params.text) {
    return {
      output: `${tag}Error: Missing required parameter: text`,
      passed: false
    }
  }

  try {
    let outputArray = []
    let jobStats = null
    const response = await model.run({
      input: params.text,
      type: 'text'
    })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          const temp = Array.from(data.outputArray)
          outputArray = outputArray.concat(temp)
        }
        if (data.event === 'JobEnded') {
          jobStats = data
        }
      })
      .await()

    let passed = true
    const sampleCount = outputArray.length
    const durationMs = response.stats?.audioDurationMs || jobStats?.audioDurationMs || (sampleCount / (sampleRate / 1000))

    if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) {
      passed = false
    }
    if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) {
      passed = false
    }
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) {
      passed = false
    }
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) {
      passed = false
    }

    const wavBuffer = createWavBuffer(outputArray, sampleRate)

    if (params.saveWav === true) {
      if (isMobile && !params.wavOutputPath) {
        console.log(`${tag}Skipping WAV save on mobile (no writable path provided)`)
      } else {
        const defaultWavPath = path.join(__dirname, '../output/test.wav')
        const wavPath = params.wavOutputPath || defaultWavPath

        const outputDir = path.dirname(wavPath)
        try {
          fs.mkdirSync(outputDir, { recursive: true })
        } catch (err) {}

        fs.writeFileSync(wavPath, wavBuffer)
        console.log(`${tag}Saved WAV to: ${wavPath}`)
      }
    }

    const stats = response.stats || jobStats

    const roundedStats = stats
      ? {
          totalTime: stats.totalTime ? Number(stats.totalTime.toFixed(4)) : stats.totalTime,
          tokensPerSecond: stats.tokensPerSecond ? Number(stats.tokensPerSecond.toFixed(2)) : stats.tokensPerSecond,
          realTimeFactor: stats.realTimeFactor ? Number(stats.realTimeFactor.toFixed(5)) : stats.realTimeFactor,
          audioDurationMs: stats.audioDurationMs,
          totalSamples: stats.totalSamples
        }
      : null

    const statsInfo = stats
      ? `duration: ${durationMs.toFixed(0)}ms, RTF: ${stats.realTimeFactor?.toFixed(4) || 'N/A'}`
      : `duration: ${durationMs.toFixed(0)}ms (calculated)`
    const output = `${tag}Synthesized ${sampleCount} samples (${statsInfo}) from text: "${params.text.substring(0, 50)}${params.text.length > 50 ? '...' : ''}"`

    return {
      output,
      passed,
      data: {
        samples: outputArray,
        sampleCount,
        durationMs,
        sampleRate,
        wavBuffer,
        stats: roundedStats
      }
    }
  } catch (error) {
    return {
      output: `${tag}Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  }
}

module.exports = { getBaseDir, isMobile, runTTS }
