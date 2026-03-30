'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const TranscriptionWhispercpp = require('../../index')
const { spawnSync, spawn } = require('bare-subprocess')

const modelsDir = path.resolve(__dirname, '../../models')
const samplesDir = path.resolve(__dirname, '../../examples/samples')
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true })
const modelPath = path.join(modelsDir, 'ggml-small.bin')
const spanishAudioPath = path.join(samplesDir, 'LastQuestion_long_ES.raw')
const spanishAudioShortPath = path.join(samplesDir, 'LastQuestion_short_ES.raw')

// Download model if needed
async function ensureModel () {
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 400000000) {
    return modelPath
  }

  console.log('Downloading test model...')
  const { spawnSync } = require('bare-subprocess')
  const result = spawnSync('curl', [
    '-L', '-o', modelPath,
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    '--fail', '--silent', '--show-error',
    '--connect-timeout', '30',
    '--max-time', '1800'
  ], { stdio: ['inherit', 'inherit', 'pipe'] })

  if (result.status === 0 && fs.existsSync(modelPath) && fs.statSync(modelPath).size > 400000000) {
    return modelPath
  }
  throw new Error('Failed to download model')
}

// Check if GPU/Vulkan is available
async function checkVulkanAvailable () {
  try {
    const args = {
      files: {
        model: modelPath
      }
    }
    const testConfig = {
      path: modelPath,
      contextParams: {
        use_gpu: true,
        gpu_device: 0
      },
      whisperConfig: {
        language: 'es',
        temperature: 0.0,
        duration_ms: 0
      },
      miscConfig: {}
    }
    const testModel = new TranscriptionWhispercpp(args, testConfig)
    await testModel._load()
    await testModel.destroy()
    return true
  } catch (err) {
    console.log('Vulkan/GPU not available:', err.message)
    return false
  }
}

// Monitor GPU usage with nvidia-smi
function startGPUMonitoring () {
  const samples = []

  // Start nvidia-smi in dmon mode (monitoring mode)
  // -s u: utilization metrics
  // -d 1: 1 second intervals
  // -c 10000: large sample count (will be killed before reaching this)
  const monitor = spawn('nvidia-smi', [
    'dmon',
    '-s', 'u', // utilization
    '-d', '1', // 1 second intervals
    '-c', '10000' // large count (will be killed before reaching this)
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Parse output
  let buffer = ''
  monitor.stdout.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || '' // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim()
      // Skip header lines and empty lines
      if (trimmed && !trimmed.startsWith('#') && trimmed.match(/^\d+\s+\d+/)) {
        const parts = trimmed.split(/\s+/)
        if (parts.length >= 2) {
          const gpuUtil = parseInt(parts[1], 10)
          const memUtil = parts.length >= 3 ? parseInt(parts[2], 10) : 0
          if (!isNaN(gpuUtil)) {
            samples.push({ gpuUtil, memUtil, timestamp: Date.now() })
          }
        }
      }
    }
  })

  monitor.stderr.on('data', (data) => {
    // Ignore stderr or log if needed
  })

  return {
    stop: () => {
      try {
        monitor.kill('SIGTERM')
      } catch (err) {
        // Ignore errors
      }
      // Give it a moment to clean up
      return new Promise((resolve) => {
        setTimeout(() => resolve(samples), 100)
      })
    },
    getSamples: () => samples
  }
}

// Get GPU stats snapshot
function getGPUSnapshot () {
  try {
    const result = spawnSync('nvidia-smi', [
      '--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 5000 })

    if (result.status === 0 && result.stdout) {
      const line = result.stdout.trim()
      if (line) {
        const parts = line.split(', ')
        if (parts.length >= 5) {
          return {
            gpuUtil: parseInt(parts[0], 10),
            memUtil: parseInt(parts[1], 10),
            memUsed: parseInt(parts[2], 10),
            memTotal: parseInt(parts[3], 10),
            temp: parseInt(parts[4], 10)
          }
        }
      }
    }
  } catch (err) {
    // nvidia-smi not available or error
  }
  return null
}

// Run transcription and measure time
async function runTranscription (args, config, description, monitorGPU = false) {
  const start = Date.now()
  let gpuMonitor = null
  let gpuStatsBefore = null
  let gpuStatsAfter = null
  let model = null

  try {
    if (monitorGPU && config.contextParams?.use_gpu) {
      gpuStatsBefore = getGPUSnapshot()
      gpuMonitor = startGPUMonitoring()
      console.log('  GPU stats before:', gpuStatsBefore)
    }

    model = new TranscriptionWhispercpp(args, config)
    console.log(`  Loading ${description} model...`)
    await model._load()
    console.log('  Model loaded, starting transcription...')

    const audioStream = fs.createReadStream(spanishAudioPath, {
      highWaterMark: 16384 // 16KB chunks
    })

    const response = await model.run(audioStream)
    let output = ''
    let wordCount = 0
    let segmentCount = 0

    await response.onUpdate((outputChunk) => {
      const items = Array.isArray(outputChunk) ? outputChunk : [outputChunk]
      const text = items.map(s => s.text).join(' ')
      output += text
      wordCount += text.trim().split(/\s+/).filter(w => w.length > 0).length
      segmentCount += items.length
    }).await()

    console.log(`  Transcription complete: ${segmentCount} segments, ${wordCount} words`)

    if (gpuMonitor) {
      const samples = await gpuMonitor.stop()
      gpuStatsAfter = getGPUSnapshot()
      console.log('  GPU stats after:', gpuStatsAfter)

      if (samples.length > 0) {
        const avgGpuUtil = samples.reduce((sum, s) => sum + s.gpuUtil, 0) / samples.length
        const maxGpuUtil = Math.max(...samples.map(s => s.gpuUtil))
        const avgMemUtil = samples.reduce((sum, s) => sum + s.memUtil, 0) / samples.length
        const maxMemUtil = Math.max(...samples.map(s => s.memUtil))

        console.log(`  GPU utilization during run: avg=${avgGpuUtil.toFixed(1)}%, max=${maxGpuUtil}%`)
        console.log(`  Memory utilization during run: avg=${avgMemUtil.toFixed(1)}%, max=${maxMemUtil}%`)
        console.log(`  Samples collected: ${samples.length}`)
      } else {
        console.log('  ⚠️  No GPU samples collected - monitoring may have failed')
      }
    }

    const end = Date.now()
    const timeMs = end - start
    const timeSec = timeMs / 1000

    return {
      output: output.trim(),
      timeMs,
      timeSec,
      wordCount,
      charCount: output.trim().length,
      gpuStatsBefore,
      gpuStatsAfter,
      gpuSamples: gpuMonitor ? gpuMonitor.getSamples() : null
    }
  } catch (error) {
    console.error(`  ❌ Error during ${description} transcription:`, error.message)
    if (gpuMonitor) {
      await gpuMonitor.stop()
    }
    throw error
  } finally {
    if (model) {
      try {
        console.log(`  Cleaning up ${description} model...`)
        await model.destroy()
      } catch (err) {
        console.error('  Warning: Error during cleanup:', err.message)
      }
    }
  }
}

test('GPU performance test with Spanish audio (LastQuestion_long_ES.raw)', { timeout: 120000 }, async (t) => {
  // Check if audio file exists
  if (!fs.existsSync(spanishAudioPath)) {
    t.skip('Spanish audio file not found')
    return
  }

  const audioSize = fs.statSync(spanishAudioPath).size
  const audioSizeMB = (audioSize / 1024 / 1024).toFixed(2)
  console.log('\n=== GPU/Vulkan Performance Test ===')
  console.log('Audio file: LastQuestion_long_ES.raw')
  console.log(`File size: ${audioSizeMB} MB`)
  console.log('Model: ggml-small.bin (466 MiB)')
  console.log('Language: Spanish (es)')
  console.log('\n✅ Using \'small\' model (466MB) to demonstrate GPU acceleration benefits.\n')
  console.log('Note: CPU comparison skipped (would take 5-10+ minutes with this model/audio size)')

  await ensureModel()

  const args = {
    files: {
      model: modelPath
    }
  }

  const baseConfig = {
    path: modelPath,
    whisperConfig: {
      language: 'es',
      temperature: 0.5,
      duration_ms: 0,
      seed: 1234 // Use seed for reproducibility
    },
    miscConfig: {}
  }

  // CPU Configuration (skipped for performance)
  // const cpuConfig = {
  //   ...baseConfig,
  //   contextParams: {
  //     use_gpu: false
  //   }
  // }

  // GPU Configuration
  const gpuConfig = {
    ...baseConfig,
    contextParams: {
      use_gpu: true,
      gpu_device: 0
    }
  }

  // Check if GPU is available
  const vulkanAvailable = await checkVulkanAvailable()

  // Run CPU test - SKIPPED for large model/long audio (would take 5-10+ minutes)
  const cpuResult = null
  console.log('\n⚠️  Skipping CPU test (ggml-small with 360s audio takes too long on CPU)')
  console.log('   This test focuses on GPU/Vulkan performance verification')

  // Run GPU test if available
  let gpuResult = null
  if (vulkanAvailable) {
    console.log('\nRunning GPU transcription with monitoring...')
    gpuResult = await runTranscription(args, gpuConfig, 'GPU', true)
    console.log(`✅ GPU completed in ${gpuResult.timeSec.toFixed(2)}s (${gpuResult.timeMs.toFixed(0)}ms)`)
    console.log(`   Output: ${gpuResult.charCount} chars, ${gpuResult.wordCount} words`)
  } else {
    console.log('\n⚠️  GPU/Vulkan not available, skipping GPU test')
    t.skip('GPU/Vulkan not available on this system')
    return
  }

  // Print results
  console.log('\n=== GPU Performance Results ===')
  if (gpuResult) {
    console.log(`GPU Time: ${gpuResult.timeSec.toFixed(2)}s (${gpuResult.timeMs.toFixed(0)}ms)`)
    console.log(`GPU output: ${gpuResult.charCount} chars, ${gpuResult.wordCount} words`)

    // Calculate throughput
    const gpuThroughput = (audioSizeMB / gpuResult.timeSec).toFixed(2)
    console.log(`Throughput: ${gpuThroughput} MB/s`)

    // Show sample output
    console.log('\nSample Output (first 200 chars):')
    console.log(`  ${gpuResult.output.substring(0, 200)}...`)
  }

  // GPU monitoring summary
  if (gpuResult && gpuResult.gpuSamples && gpuResult.gpuSamples.length > 0) {
    const samples = gpuResult.gpuSamples
    const avgGpuUtil = samples.reduce((sum, s) => sum + s.gpuUtil, 0) / samples.length
    const maxGpuUtil = Math.max(...samples.map(s => s.gpuUtil))
    const avgMemUtil = samples.reduce((sum, s) => sum + s.memUtil, 0) / samples.length
    const maxMemUtil = Math.max(...samples.map(s => s.memUtil))

    console.log('\n=== GPU Usage Summary ===')
    console.log(`Average GPU Utilization: ${avgGpuUtil.toFixed(1)}%`)
    console.log(`Peak GPU Utilization: ${maxGpuUtil}%`)
    console.log(`Average Memory Utilization: ${avgMemUtil.toFixed(1)}%`)
    console.log(`Peak Memory Utilization: ${maxMemUtil}%`)
    if (avgGpuUtil < 10) {
      console.log('⚠️  WARNING: Low GPU utilization suggests GPU may not be actively used')
    } else if (avgGpuUtil > 50) {
      console.log('✅ GPU is actively being used')
    } else {
      console.log('⚠️  GPU utilization is moderate - may indicate partial GPU usage')
    }
  }

  // Verify we got meaningful output (prefer GPU result, fallback to CPU if available)
  const result = gpuResult || cpuResult
  t.ok(result, 'Should have completed at least one transcription (CPU or GPU)')
  t.ok(result.wordCount > 100, `Should produce meaningful transcription (got ${result.wordCount} words)`)
  t.ok(result.charCount > 1000, `Should produce substantial output (got ${result.charCount} chars)`)
})

test('Multiple GPU runs with seed for consistency check', { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(spanishAudioPath)) {
    t.skip('Spanish audio file not found')
    return
  }

  const vulkanAvailable = await checkVulkanAvailable()
  if (!vulkanAvailable) {
    t.skip('GPU/Vulkan not available on this system')
    return
  }

  await ensureModel()

  const args = {
    files: {
      model: modelPath
    }
  }

  const seed = 9999
  const config = {
    path: modelPath,
    contextParams: {
      use_gpu: true,
      gpu_device: 0
    },
    whisperConfig: {
      language: 'es',
      temperature: 0.5,
      duration_ms: 0,
      seed
    },
    miscConfig: {}
  }

  console.log('\n=== Multiple GPU Runs Consistency Test ===')
  console.log(`Running 3 consecutive GPU runs with seed ${seed}...\n`)

  const results = []
  for (let i = 0; i < 3; i++) {
    console.log(`Run ${i + 1}/3...`)
    const result = await runTranscription(args, config, `GPU Run ${i + 1}`, i === 0) // Monitor first run only
    results.push(result)
    console.log(`  Completed in ${result.timeSec.toFixed(2)}s`)
  }

  // Check all outputs are identical
  const firstOutput = results[0].output
  for (let i = 1; i < results.length; i++) {
    t.is(results[i].output, firstOutput, `Run ${i + 1} should match run 1 with same seed`)
  }

  console.log('\n=== Consistency Results ===')
  console.log(`All ${results.length} runs produced identical output`)
  console.log(`Average time: ${(results.reduce((sum, r) => sum + r.timeMs, 0) / results.length).toFixed(0)}ms`)
  console.log(`Output: ${results[0].charCount} chars, ${results[0].wordCount} words`)
})

test('CPU vs GPU speed comparison with SHORT audio (30s sample)', { timeout: 300000 }, async (t) => {
  // Check if short audio file exists
  if (!fs.existsSync(spanishAudioShortPath)) {
    t.skip('Short Spanish audio file not found')
    return
  }

  const audioSize = fs.statSync(spanishAudioShortPath).size
  const audioSizeMB = (audioSize / 1024 / 1024).toFixed(2)
  const audioDurationSec = (audioSize / (16000 * 2)).toFixed(1) // s16le at 16kHz

  console.log('\n=== CPU vs GPU Speed Comparison (Short Audio) ===')
  console.log('Audio file: LastQuestion_short_ES.raw')
  console.log(`File size: ${audioSizeMB} MB (~${audioDurationSec}s audio)`)
  console.log('Model: ggml-small.bin (466 MiB)')
  console.log('Language: Spanish (es)')
  console.log('\n✅ Using shorter audio to enable practical CPU vs GPU comparison\n')

  await ensureModel()

  const args = {
    files: {
      model: modelPath
    }
  }

  const baseConfig = {
    path: modelPath,
    whisperConfig: {
      language: 'es',
      temperature: 0.5,
      duration_ms: 0,
      seed: 1234,
      n_threads: 8 // Use 8 threads for CPU
    },
    miscConfig: {}
  }

  // CPU Configuration
  const cpuConfig = {
    ...baseConfig,
    contextParams: {
      use_gpu: false
    }
  }

  // GPU Configuration
  const gpuConfig = {
    ...baseConfig,
    contextParams: {
      use_gpu: true,
      gpu_device: 0
    }
  }

  // Check if GPU is available
  const vulkanAvailable = await checkVulkanAvailable()
  if (!vulkanAvailable) {
    t.skip('GPU/Vulkan not available on this system')
    return
  }

  // Helper function for short audio
  async function runShortTranscription (config, description, monitorGPU = false) {
    const start = Date.now()
    let gpuMonitor = null
    let model = null

    try {
      if (monitorGPU) {
        gpuMonitor = startGPUMonitoring()
      }

      model = new TranscriptionWhispercpp(args, config)
      console.log(`  Loading ${description} model...`)
      await model._load()

      const audioStream = fs.createReadStream(spanishAudioShortPath, {
        highWaterMark: 16384
      })

      const response = await model.run(audioStream)
      let output = ''
      let wordCount = 0
      let segmentCount = 0

      await response.onUpdate((outputChunk) => {
        const items = Array.isArray(outputChunk) ? outputChunk : [outputChunk]
        const text = items.map(s => s.text).join(' ')
        output += text
        wordCount += text.trim().split(/\s+/).filter(w => w.length > 0).length
        segmentCount += items.length
      }).await()

      const timeMs = Date.now() - start
      const timeSec = timeMs / 1000

      let gpuSamples = null
      if (gpuMonitor) {
        gpuSamples = await gpuMonitor.stop()
      }

      return {
        output: output.trim(),
        timeMs,
        timeSec,
        wordCount,
        charCount: output.trim().length,
        segmentCount,
        gpuSamples
      }
    } finally {
      if (model) {
        await model.destroy()
      }
    }
  }

  // Run CPU test
  console.log('\nRunning CPU transcription...')
  const cpuResult = await runShortTranscription(cpuConfig, 'CPU', false)
  console.log(`✅ CPU completed in ${cpuResult.timeSec.toFixed(2)}s`)
  console.log(`   Output: ${cpuResult.charCount} chars, ${cpuResult.wordCount} words, ${cpuResult.segmentCount} segments`)

  // Run GPU test
  console.log('\nRunning GPU transcription...')
  const gpuResult = await runShortTranscription(gpuConfig, 'GPU', true)
  console.log(`✅ GPU completed in ${gpuResult.timeSec.toFixed(2)}s`)
  console.log(`   Output: ${gpuResult.charCount} chars, ${gpuResult.wordCount} words, ${gpuResult.segmentCount} segments`)

  // Print comparison
  console.log('\n=== Performance Comparison ===')
  console.log(`CPU Time: ${cpuResult.timeSec.toFixed(2)}s`)
  console.log(`GPU Time: ${gpuResult.timeSec.toFixed(2)}s`)

  const speedup = cpuResult.timeMs / gpuResult.timeMs
  const improvement = ((cpuResult.timeMs - gpuResult.timeMs) / cpuResult.timeMs * 100).toFixed(1)

  console.log(`\n🚀 Speedup: ${speedup.toFixed(2)}x faster with GPU`)
  console.log(`   Improvement: ${improvement}% time reduction`)
  console.log(`   Time saved: ${((cpuResult.timeMs - gpuResult.timeMs) / 1000).toFixed(2)}s`)

  // Calculate throughput
  const cpuThroughput = (audioSizeMB / cpuResult.timeSec).toFixed(3)
  const gpuThroughput = (audioSizeMB / gpuResult.timeSec).toFixed(3)
  console.log('\n📊 Throughput:')
  console.log(`   CPU: ${cpuThroughput} MB/s`)
  console.log(`   GPU: ${gpuThroughput} MB/s`)

  // Verify outputs are similar
  const wordDiff = Math.abs(cpuResult.wordCount - gpuResult.wordCount)
  console.log('\n📝 Output Comparison:')
  console.log(`   CPU: ${cpuResult.wordCount} words, ${cpuResult.segmentCount} segments`)
  console.log(`   GPU: ${gpuResult.wordCount} words, ${gpuResult.segmentCount} segments`)
  console.log(`   Difference: ${wordDiff} words`)

  // GPU monitoring summary
  if (gpuResult.gpuSamples && gpuResult.gpuSamples.length > 0) {
    const samples = gpuResult.gpuSamples
    const avgGpuUtil = samples.reduce((sum, s) => sum + s.gpuUtil, 0) / samples.length
    const maxGpuUtil = Math.max(...samples.map(s => s.gpuUtil))

    console.log('\n🎮 GPU Usage:')
    console.log(`   Average: ${avgGpuUtil.toFixed(1)}%`)
    console.log(`   Peak: ${maxGpuUtil}%`)
  }

  // Assertions
  t.ok(cpuResult.wordCount > 50, `CPU should produce meaningful output (got ${cpuResult.wordCount} words)`)
  t.ok(gpuResult.wordCount > 50, `GPU should produce meaningful output (got ${gpuResult.wordCount} words)`)
  t.ok(speedup > 1.5, `GPU should be faster than CPU (speedup: ${speedup.toFixed(2)}x)`)
  t.ok(Math.abs(cpuResult.wordCount - gpuResult.wordCount) <= 20,
    `CPU and GPU outputs should be similar (word diff: ${wordDiff})`)
})
