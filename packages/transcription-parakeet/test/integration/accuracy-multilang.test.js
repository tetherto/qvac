'use strict'

/**
 * Accuracy and multi-language tests.
 *
 * English is gated on Word Error Rate (WER), once with the multilingual
 * TDT v3 GGUF (the addon's default) and once with the English-only CTC
 * GGUF; both should land within the 30 % WER threshold on a clean clip.
 * The non-English tests run against TDT only and verify multi-segment
 * non-empty output for Spanish / French / Croatian audio (TDT v3
 * handles ~25 languages natively). Per-language WER for non-English
 * remains a separate task pending reference transcripts.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  binding,
  TranscriptionParakeet,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  validateAccuracy,
  loadGgufOrSkip,
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
async function runLanguageTest (t, langConfig, loggerBinding, stagedGguf) {
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

  const model = new TranscriptionParakeet({
    files: { model: stagedGguf },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })

  const transcriptions = []

  try {
    await model.load()

    const response = await model.run(audioData)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        for (const seg of items) {
          if (seg && seg.text) transcriptions.push(seg)
        }
      })
      .await()

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
      // No reference transcript supplied for this language; verify
      // the engine produced non-empty output. Useful as a smoke test
      // for multilingual GGUFs (TDT v3) and as a "doesn't crash"
      // check for English-only GGUFs (CTC).
      const hasOutput = fullText.length > 0
      console.log(`\nℹ️ No reference transcript for ${langConfig.name}; checking output non-emptiness`)
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
    try { await model.unload() } catch (e) { /* ignore */ }
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
  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.en, loggerBinding, stagedGguf)

    if (result.skipped) {
      t.pass(`English accuracy test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`English accuracy test failed: ${result.error}`)
    } else {
      t.ok(result.passed, `English WER should be below ${LANGUAGE_TESTS.en.threshold * 100}%, got ${result.werPercent}`)
      t.ok(result.segmentCount > 0, `Should produce segments (got ${result.segmentCount})`)
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

/**
 * Spanish transcription test (non-English behavior verification)
 */
test('Transcription test - Spanish (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('SPANISH TRANSCRIPTION TEST')
  console.log('='.repeat(60))

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.es, loggerBinding, stagedGguf)

    if (result.skipped) {
      t.pass(`Spanish test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`Spanish test failed: ${result.error}`)
    } else {
      // No reference transcript yet, so we only assert non-empty
      // multi-segment output. TDT v3 should produce real Spanish
      // text here; CTC GGUFs would produce gibberish-but-non-empty.
      t.ok(result.segmentCount > 0, `Should produce at least one segment for Spanish audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for Spanish audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ Spanish audio produced output')
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

/**
 * French transcription test (non-English behavior verification)
 */
test('Transcription test - French (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('FRENCH TRANSCRIPTION TEST')
  console.log('='.repeat(60))

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.fr, loggerBinding, stagedGguf)

    if (result.skipped) {
      t.pass(`French test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`French test failed: ${result.error}`)
    } else {
      t.ok(result.segmentCount > 0, `Should produce at least one segment for French audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for French audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ French audio produced output')
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

/**
 * Croatian transcription test (non-English behavior verification)
 */
test('Transcription test - Croatian (non-primary language)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('CROATIAN TRANSCRIPTION TEST')
  console.log('='.repeat(60))

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.hr, loggerBinding, stagedGguf)

    if (result.skipped) {
      t.pass(`Croatian test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`Croatian test failed: ${result.error}`)
    } else {
      t.ok(result.segmentCount > 0, `Should produce at least one segment for Croatian audio (got ${result.segmentCount})`)
      t.ok(result.actualText.length > 0, `Should produce non-empty text for Croatian audio (got ${result.actualText.length} chars)`)
      console.log('\n✅ Croatian audio produced output')
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

/**
 * CTC English accuracy test with WER validation.
 *
 * Mirrors the TDT-default English test above but loads the CTC GGUF
 * explicitly. CTC is English-only and uses a different decoder
 * topology than TDT, so we want an independent WER signal: a
 * regression in the CTC head (e.g. a ggml-cpu / ggml-metal mat-mul
 * patch breaking only one of the two heads) wouldn't be caught by
 * the TDT-default English test alone.
 *
 * Skipped on mobile (CTC GGUF intentionally not bundled into the
 * mobile test app -- see helpers.js MODEL_CONFIGS comments).
 */
test('Accuracy test - English (CTC head)', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('ENGLISH ACCURACY TEST (CTC)')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)

  const stagedGguf = await loadGgufOrSkip(t, 'ctc')
  if (!stagedGguf) return
  console.log(` Model: ${stagedGguf}`)

  try {
    const result = await runLanguageTest(t, LANGUAGE_TESTS.en, loggerBinding, stagedGguf)

    if (result.skipped) {
      t.pass(`CTC English accuracy test skipped (${result.reason})`)
    } else if (result.error) {
      t.fail(`CTC English accuracy test failed: ${result.error}`)
    } else {
      t.ok(result.passed, `CTC English WER should be below ${LANGUAGE_TESTS.en.threshold * 100}%, got ${result.werPercent}`)
      t.ok(result.segmentCount > 0, `Should produce segments (got ${result.segmentCount})`)
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
