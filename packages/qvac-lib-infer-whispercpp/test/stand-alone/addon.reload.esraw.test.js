'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const { WhisperInterface } = require('../../whisper')
const binding = require('../../binding')

const modelsDir = path.resolve(__dirname, '../../models')
const samplesDir = path.resolve(__dirname, '../../examples/samples')
const modelPath = path.join(modelsDir, 'ggml-tiny.bin')
const audioPath = path.join(samplesDir, 'LastQuestion_long_ES.raw')

function chunkBuffer (buf, size) {
  const chunks = []
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.slice(i, i + size))
  return chunks
}

test('Addon reload: French → Spanish transcription of LastQuestion_long_ES.raw', async (t) => {
  t.ok(fs.existsSync(audioPath), 'Audio sample exists')
  t.ok(fs.existsSync(modelPath), 'Model file exists')

  const audioStats = fs.statSync(audioPath)
  console.log(`\n📁 Audio file: ${path.basename(audioPath)}`)
  console.log(`   Size: ${audioStats.size} bytes`)
  console.log(`   Duration (estimated): ${(audioStats.size / (16000 * 2)).toFixed(2)} seconds\n`)

  const events = []
  let jobEndedCount = 0
  let jobStartTime = null
  let currentLanguage = 'fr'

  const onOutput = (addon, event, jobId, output, error) => {
    const timestamp = new Date().toISOString()
    events.push({ event, jobId, output, error, timestamp, language: currentLanguage })

    switch (event) {
      case 'JobStarted':
        jobStartTime = Date.now()
        console.log(`\n🚀 [${timestamp}] Job ${jobId} started (Language: ${currentLanguage.toUpperCase()})`)
        break

      case 'Output': {
        const elapsed = jobStartTime ? ((Date.now() - jobStartTime) / 1000).toFixed(2) : 'unknown'

        // Handle array of transcript objects - show only the transcription text
        if (Array.isArray(output)) {
          output.forEach((segment) => {
            if (segment && segment.text) {
              console.log(`📝 [${elapsed}s] "${segment.text}"`)
              if (segment.start !== undefined && segment.end !== undefined) {
                console.log(`   ⏱️  ${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s`)
              }
            }
          })
        } else if (output && typeof output === 'object' && output.text) {
          console.log(`📝 [${elapsed}s] "${output.text}"`)
          if (output.start !== undefined && output.end !== undefined) {
            console.log(`   ⏱️  ${output.start.toFixed(2)}s - ${output.end.toFixed(2)}s`)
          }
        }
        break
      }

      case 'JobEnded': {
        const totalTime = jobStartTime ? ((Date.now() - jobStartTime) / 1000).toFixed(2) : 'unknown'
        console.log(`\n✅ [${timestamp}] Job ${jobId} completed in ${totalTime}s`)
        if (output) {
          console.log('   Stats:', JSON.stringify(output, null, 2))
        }
        jobEndedCount++
        break
      }

      case 'Error':
        console.log(`\n❌ [${timestamp}] Error [${jobId}]:`, error)
        break

      default:
        console.log(`\nℹ️  [${timestamp}] Event [${jobId}]: ${event}`)
    }
  }

  // Initial config: French
  const frenchConfig = {
    contextParams: { model: modelPath },
    whisperConfig: { language: 'fr', duration_ms: 0, temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  console.log('🔧 Creating addon with FRENCH configuration...')
  const addon = new WhisperInterface(binding, frenchConfig, onOutput)

  console.log('🔧 Activating addon...')
  await addon.activate()

  console.log('🎵 Reading audio file...')
  const audio = fs.readFileSync(audioPath)

  // Process a reasonable portion of the audio
  const audioChunk = audio.slice(0, 16000 * 2 * 5) // ~5s at 16kHz s16le
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('   FIRST RUN: FRENCH (Wrong Language for Spanish Audio)')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`Processing ${audioChunk.length} bytes of audio...`)

  for (const chunk of chunkBuffer(audioChunk, 2048)) {
    await addon.append({ type: 'audio', input: chunk })
  }
  await addon.append({ type: 'end of job' })

  // Wait for first job to complete
  console.log('\n⏳ Waiting for first job to complete...')
  const startTime1 = Date.now()
  // eslint-disable-next-line no-unmodified-loop-condition
  while (jobEndedCount < 1 && Date.now() - startTime1 < 30000) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  const job1Events = events.filter(e => e.jobId === events.find(e => e.event === 'JobStarted')?.jobId)
  console.log(`\n📊 First job summary: ${job1Events.length} events`)

  // Now reload with Spanish config
  console.log(`\n${'='.repeat(55)}`)
  console.log('   RELOADING: Switching to SPANISH (Correct Language)')
  console.log(`${'='.repeat(55)}`)

  const spanishConfig = {
    contextParams: { model: modelPath },
    whisperConfig: { language: 'es', duration_ms: 0, temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  currentLanguage = 'es'
  console.log('🔧 Reloading addon with SPANISH configuration...')
  await addon.reload(spanishConfig)

  console.log('🔧 Activating after reload...')
  await addon.activate()

  console.log(`\n${'='.repeat(55)}`)
  console.log('   SECOND RUN: SPANISH (Correct Language for Spanish Audio)')
  console.log(`${'='.repeat(55)}`)
  console.log(`Processing ${audioChunk.length} bytes of audio...`)

  for (const chunk of chunkBuffer(audioChunk, 2048)) {
    await addon.append({ type: 'audio', input: chunk })
  }
  await addon.append({ type: 'end of job' })

  // Wait for second job to complete
  console.log('\n⏳ Waiting for second job to complete...')
  const startTime2 = Date.now()
  // eslint-disable-next-line no-unmodified-loop-condition
  while (jobEndedCount < 2 && Date.now() - startTime2 < 30000) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  console.log(`\n${'='.repeat(55)}`)
  console.log('   FINAL RESULTS')
  console.log(`${'='.repeat(55)}`)

  // Analyze results
  const outputEvents = events.filter(e => e.event === 'Output')
  const jobEndedEvents = events.filter(e => e.event === 'JobEnded')
  const frenchOutputs = events.filter(e => e.event === 'Output' && e.language === 'fr')
  const spanishOutputs = events.filter(e => e.event === 'Output' && e.language === 'es')

  console.log(`\n📊 Total events received: ${events.length}`)
  console.log(`   - Output events: ${outputEvents.length}`)
  console.log(`   - Job completed events: ${jobEndedEvents.length}`)
  console.log(`   - French outputs: ${frenchOutputs.length}`)
  console.log(`   - Spanish outputs: ${spanishOutputs.length}`)

  console.log(`\n📝 French Transcription (${frenchOutputs.length} segments):`)
  frenchOutputs.forEach((event, idx) => {
    if (Array.isArray(event.output)) {
      event.output.forEach(segment => {
        if (segment && segment.text) {
          console.log(`   [${idx + 1}] "${segment.text}"`)
        }
      })
    }
  })

  console.log(`\n📝 Spanish Transcription (${spanishOutputs.length} segments):`)
  spanishOutputs.forEach((event, idx) => {
    if (Array.isArray(event.output)) {
      event.output.forEach(segment => {
        if (segment && segment.text) {
          console.log(`   [${idx + 1}] "${segment.text}"`)
        }
      })
    }
  })

  // Assertions
  t.ok(outputEvents.length > 0, 'Should produce output events')
  t.ok(jobEndedEvents.length >= 2, 'Should mark both jobs as ended')
  t.ok(frenchOutputs.length > 0, 'Should produce French transcription')
  t.ok(spanishOutputs.length > 0, 'Should produce Spanish transcription')

  console.log('\n🎉 SUCCESS: Reload test completed successfully!')
  console.log('   Model was reloaded and processed audio in both languages.\n')

  // Clean up
  console.log('🔧 Destroying addon...')
  await addon.destroyInstance()
  console.log('🔧 Addon destroyed successfully\n')
})
