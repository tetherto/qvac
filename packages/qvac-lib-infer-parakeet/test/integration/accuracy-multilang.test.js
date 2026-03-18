'use strict'

/**
 * Accuracy and Multi-Language Tests
 *
 * Tests transcription accuracy using Word Error Rate (WER).
 * Note: NVIDIA Parakeet models are primarily trained on English,
 * so non-English tests verify the model handles other languages
 * gracefully (may not produce accurate transcriptions).
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  validateAccuracy,
  ensureModel,
  getNamedPathsConfig,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

// Language test configurations
const LANGUAGE_TESTS = {
  en: {
    name: 'English',
    code: 'en',
    sampleFile: 'sample.raw',
    expected: 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations',
    threshold: 0.30 // 30% WER threshold
  },
  es: {
    name: 'Spanish',
    code: 'es',
    sampleFile: 'LastQuestion_long_ES.raw',
    expected: null, // Will just check for non-empty output
    threshold: null,
    maxDurationSeconds: 60 // Truncate to 60s for CI (full file is 360s)
  },
  fr: {
    name: 'French',
    code: 'fr',
    sampleFile: 'French.raw',
    expected: null,
    threshold: null
  },
  hr: {
    name: 'Croatian',
    code: 'hr',
    sampleFile: 'croatian.raw',
    expected: null,
    threshold: null
  }
}

/**
 * Helper function to run transcription for a specific language
 */
async function runLanguageTest (t, langConfig, loggerBinding) {
  const samplePath = path.join(samplesDir, langConfig.sampleFile)

  // Check if sample exists
  if (!fs.existsSync(samplePath)) {
    console.log(`⚠️ Sample file not available: ${langConfig.sampleFile}`)
    return { skipped: true, reason: 'sample_not_found' }
  }

  console.log(`\n📊 Running ${langConfig.name} accuracy test...`)
  console.log(`   File: ${langConfig.sampleFile}`)
  console.log(`   Language code: ${langConfig.code}`)
  console.log(`   Platform: ${isMobile ? 'mobile' : 'desktop'}`)

  // Load audio
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)

  // Truncate if maxDurationSeconds is specified (for CI resource limits)
  const sampleRate = 16000
  let samplesToUse = pcmData.length
  if (langConfig.maxDurationSeconds) {
    const maxSamples = langConfig.maxDurationSeconds * sampleRate
    if (pcmData.length > maxSamples) {
      samplesToUse = maxSamples
      console.log(`   ⚠️  Truncating from ${(pcmData.length / sampleRate).toFixed(2)}s to ${langConfig.maxDurationSeconds}s for CI`)
    }
  }

  const audioData = new Float32Array(samplesToUse)
  for (let i = 0; i < samplesToUse; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  console.log(`   Audio duration: ${(audioData.length / sampleRate).toFixed(2)}s`)

  // Configuration
  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: 16000,
    channels: 1,
    ...getNamedPathsConfig('tdt', modelPath)
  }

  // Track transcription
  const transcriptions = []
  let jobDoneResolve = null
  const jobDonePromise = new Promise(resolve => { jobDoneResolve = resolve })

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      for (const segment of output) {
        if (segment && segment.text) {
          transcriptions.push(segment)
        }
      }
    }
    if (event === 'Error') {
      console.log(`   Error: ${error}`)
      if (jobDoneResolve) {
        jobDoneResolve()
        jobDoneResolve = null
      }
    }
    if (event === 'JobEnded') {
      if (jobDoneResolve) {
        jobDoneResolve()
        jobDoneResolve = null
      }
    }
  }

  let parakeet = null

  try {
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()

    // Transcribe
    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    // Wait for output with timeout (10 min should be enough for truncated audio)
    const timeout = setTimeout(() => {
      if (jobDoneResolve) {
        jobDoneResolve()
        jobDoneResolve = null
      }
    }, 600000)
    await jobDonePromise
    clearTimeout(timeout)

    // Get results
    const fullText = transcriptions.map(s => s.text).join(' ').trim()

    console.log(`\n📝 ${langConfig.name} transcription (${transcriptions.length} segments):`)
    console.log(`   "${fullText.substring(0, 150)}${fullText.length > 150 ? '...' : ''}"`)

    // Validate accuracy if expected text is provided
    if (langConfig.expected && langConfig.threshold !== null) {
      const accuracy = validateAccuracy(langConfig.expected, fullText, langConfig.threshold)

      console.log('\n📊 WER Analysis:')
      console.log(`   WER:      ${accuracy.werPercent} (threshold: ${langConfig.threshold * 100}%)`)
      console.log(`   Status:   ${accuracy.passed ? '✅ PASSED' : '❌ FAILED'}`)

      return {
        skipped: false,
        passed: accuracy.passed,
        wer: accuracy.wer,
        werPercent: accuracy.werPercent,
        actualText: fullText,
        segmentCount: transcriptions.length
      }
    } else {
      // For non-English, just verify we got some output
      const hasOutput = fullText.length > 0
      console.log('\n⚠️ No WER validation - Parakeet is English-only')
      console.log(`   Output received: ${hasOutput ? 'Yes' : 'No'}`)
      console.log(`   Text length: ${fullText.length} characters`)

      return {
        skipped: false,
        passed: hasOutput,
        actualText: fullText,
        segmentCount: transcriptions.length,
        noWerValidation: true
      }
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`)
    return { skipped: false, passed: false, error: error.message }
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * English accuracy test with WER validation
 */
test('Accuracy test - English (primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('ENGLISH ACCURACY TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log('='.repeat(60))

  // Ensure model is available
  await ensureModel(modelPath)

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.en, loggerBinding)

    if (result.skipped) {
      t.pass(`English accuracy test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`English accuracy test failed: ${result.error}`)
    } else {
      t.ok(result.passed, `English WER should be below ${LANGUAGE_TESTS.en.threshold * 100}%, got ${result.werPercent}`)
      t.ok(result.segmentCount > 0, `Should produce segments (got ${result.segmentCount})`)
    }
  } finally {
    // Logger is released once at the end of the summary test.
  }
})

/**
 * Spanish transcription test (non-English behavior verification)
 */
test('Transcription test - Spanish (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('SPANISH TRANSCRIPTION TEST')
  console.log('Note: Parakeet is English-only, testing graceful handling')
  console.log('='.repeat(60))

  await ensureModel(modelPath)

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.es, loggerBinding)

    if (result.skipped) {
      t.pass(`Spanish test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`Spanish test failed: ${result.error}`)
    } else {
      // For non-English, verify no crash and non-empty transcription payload.
      t.ok(result.segmentCount > 0, `Should produce at least one segment for Spanish audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for Spanish audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ Spanish audio handled gracefully')
    }
  } finally {
    // Logger is released once at the end of the summary test.
  }
})

/**
 * French transcription test (non-English behavior verification)
 */
test('Transcription test - French (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('FRENCH TRANSCRIPTION TEST')
  console.log('Note: Parakeet is English-only, testing graceful handling')
  console.log('='.repeat(60))

  await ensureModel(modelPath)

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.fr, loggerBinding)

    if (result.skipped) {
      t.pass(`French test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`French test failed: ${result.error}`)
    } else {
      t.ok(result.segmentCount > 0, `Should produce at least one segment for French audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for French audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ French audio handled gracefully')
    }
  } finally {
    // Logger is released once at the end of the summary test.
  }
})

/**
 * Croatian transcription test (non-English behavior verification)
 */
test('Transcription test - Croatian (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('CROATIAN TRANSCRIPTION TEST')
  console.log('Note: Parakeet is English-only, testing graceful handling')
  console.log('='.repeat(60))

  await ensureModel(modelPath)

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.hr, loggerBinding)

    if (result.skipped) {
      t.pass(`Croatian test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`Croatian test failed: ${result.error}`)
    } else {
      t.ok(result.segmentCount > 0, `Should produce at least one segment for Croatian audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for Croatian audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ Croatian audio handled gracefully')
    }
  } finally {
    // Logger is released once at the end of the summary test.
  }
})

/**
 * Summary test - run all languages and report results
 */
test('Multi-language summary test', { timeout: 900000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('MULTI-LANGUAGE SUMMARY TEST')
  console.log('='.repeat(60))

  await ensureModel(modelPath)

  const results = {}

  for (const [code, config] of Object.entries(LANGUAGE_TESTS)) {
    results[code] = await runLanguageTest(t, config, loggerBinding)
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('📊 SUMMARY')
  console.log('='.repeat(60))

  let passedCount = 0
  let skippedCount = 0
  let failedCount = 0

  for (const [code, result] of Object.entries(results)) {
    const config = LANGUAGE_TESTS[code]
    let status = ''

    if (result.skipped) {
      status = '⏭️ SKIPPED'
      skippedCount++
    } else if (result.passed) {
      status = '✅ PASSED'
      passedCount++
    } else {
      status = '❌ FAILED'
      failedCount++
    }

    console.log(`\n  ${config.name} (${code}): ${status}`)
    if (result.werPercent) {
      console.log(`    WER: ${result.werPercent}`)
    }
    if (result.segmentCount !== undefined) {
      console.log(`    Segments: ${result.segmentCount}`)
    }
    if (result.error) {
      console.log(`    Error: ${result.error}`)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`  Total: ${passedCount} passed, ${skippedCount} skipped, ${failedCount} failed`)
  console.log('='.repeat(60) + '\n')

  // Assertions
  t.ok(passedCount > 0, 'At least one language test should pass')
  t.ok(results.en?.passed !== false, 'English test should pass (primary language)')

  try {
    loggerBinding.releaseLogger()
  } catch (e) {
    // Ignore
  }
})
