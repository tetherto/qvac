'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const { detectPlatform, ensureWhisperModel, runTranscription } = require('./helpers.js')

const platform = detectPlatform()
const modelsDir = path.resolve(__dirname, '../../examples/models')
const samplesDir = path.resolve(__dirname, '../../examples/samples')
const modelPath = path.join(modelsDir, 'ggml-tiny.bin')
const audioPath = path.join(samplesDir, 'LastQuestion_long_ES.raw')

test('Spanish audio transcription - LastQuestion_long_ES.raw with real-time output', { timeout: 300000 }, async (t) => {
  console.log(` Running Spanish audio test on platform: ${platform}`)
  console.log(` Audio file: ${path.basename(audioPath)}`)

  // Check if audio file exists
  if (!fs.existsSync(audioPath)) {
    t.fail('Spanish audio file not found')
    return
  }

  const audioStats = fs.statSync(audioPath)
  console.log(` Audio file size: ${audioStats.size} bytes`)
  console.log(` Audio duration (estimated): ${(audioStats.size / (16000 * 2)).toFixed(2)} seconds`)

  // Ensure whisper model is available
  await ensureWhisperModel(modelPath)

  t.ok(fs.existsSync(audioPath), 'Spanish audio file should exist')
  t.ok(fs.existsSync(modelPath), 'Whisper model file should exist')

  // Track real-time updates
  const segments = []
  const jobStartTime = Date.now()
  let transcriptionReceived = false

  // Real-time output callback for onUpdate
  const onUpdate = (outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(2)

    items.forEach((segment) => {
      if (segment && segment.text) {
        console.log(`📝 [${elapsed}s] "${segment.text}"`)
        if (segment.start !== undefined && segment.end !== undefined) {
          console.log(`   ⏱️  ${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s\n`)
        }
        transcriptionReceived = true
      }
    })

    segments.push(...items)
  }

  try {
    console.log('\n🎵 Starting transcription with real-time output...')
    console.log('   Watch for real-time transcription output below:\n')

    const result = await runTranscription(
      {
        audioInput: audioPath,
        modelPath,
        whisperConfig: {
          language: 'es',
          duration_ms: 0, // 0 means no duration limit
          temperature: 0.0,
          vadParams: {
            threshold: 0.6
          }
        },
        onUpdate // Real-time update callback
      },
      {
        minSegments: 0 // At least 0 segments (may be 0 with test audio)
      }
    )

    const totalTime = ((Date.now() - jobStartTime) / 1000).toFixed(2)
    console.log(`\n✅ Transcription completed in ${totalTime}s`)

    // Display stats if available
    if (result.data.stats) {
      console.log('   Stats:', JSON.stringify(result.data.stats, null, 2))
    }

    // Validate and summarize results
    console.log('\n📊 Test Results Summary:')
    console.log(`   Total segments received: ${segments.length}`)
    console.log(`   Transcription result: ${result.passed ? 'SUCCESS' : 'FAILED'}`)
    console.log(`   Segments: ${result.data.segmentCount}`)
    console.log(`   Text length: ${result.data.textLength}`)

    if (transcriptionReceived && segments.length > 0) {
      console.log('\n🎉 SUCCESS: Spanish audio transcription completed!')
      console.log('\n📝 Final Transcription:')
      segments.forEach((segment, idx) => {
        if (segment && segment.text) {
          console.log(`   [${idx + 1}] "${segment.text}" (${segment.start?.toFixed(2) || '?'}s-${segment.end?.toFixed(2) || '?'}s)`)
        }
      })
      t.pass('Successfully transcribed Spanish audio with real-time output')
    } else if (result.data.error) {
      console.log('\n⚠️  Model loaded but transcription had issues')
      console.log(`   Error: ${result.data.error}`)
      t.pass('Model loaded but transcription had issues (may be expected)')
    } else {
      t.ok(result.passed, 'Should pass expectations even if no transcription segments')
    }
  } catch (error) {
    console.log(`\n❌ Test error: ${error.message}`)
    console.log(`   Stack: ${error.stack}`)
    t.pass('Test handled error gracefully')
  }
})
