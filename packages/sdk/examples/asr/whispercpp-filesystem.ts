import { loadModel, unloadModel, transcribe, WHISPER_TINY } from '@qvac/sdk'

// Parse command line arguments
const args = process.argv.slice(2)

if (!args[0]) {
  console.error('Usage: npx tsx examples/asr/whispercpp-filesystem.ts <wav-file-path>')
  process.exit(1)
}

const audioFilePath = args[0]

try {
  console.log('▸ Starting Whisper transcription example...')

  // Load the Whisper model
  console.log('▸ Loading Whisper model...')
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: {
      audioFormat: 'f32le',
      // Sampling strategy
      strategy: 'greedy',
      threads: 4,
      // Transcription options
      language: 'en',
      translate: false,
      noTimestamps: false,
      singleSegment: false,
      printTimestamps: true,
      tokenTimestamps: true,
      // Quality settings
      temperature: 0.0,
      suppressBlank: true,
      suppressNst: true,
      // Advanced tuning
      entropyThold: 2.4,
      logprobThold: -1.0,
      // VAD configuration
      vadParams: {
        threshold: 0.35,
        minSpeechDurationMs: 200,
        minSilenceDurationMs: 150,
        maxSpeechDurationS: 30.0,
        speechPadMs: 600,
        samplesOverlap: 0.3
      },
      // Context parameters for GPU
      contextParams: {
        useGpu: true,
        flashAttention: true,
        gpuDevice: 0
      }
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Whisper model loaded with ID: ${modelId}`)

  // Perform transcription with per-segment metadata
  console.log('▸ Transcribing audio...')
  const segments = await transcribe({
    modelId,
    audioChunk: audioFilePath,
    metadata: true
  })

  console.log('▸ Transcription result:')
  for (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2)
    const end = (segment.endMs / 1000).toFixed(2)
    console.log(
      `  [${start}s → ${end}s] (id=${segment.id}, append=${segment.append}) ${segment.text}`
    )
  }
  console.log(
    `\nFull transcript: ${segments
      .map((s) => s.text)
      .join('')
      .trim()}`
  )

  // Unload the model when done
  console.log('▸ Unloading Whisper model...')
  await unloadModel({ modelId })
  console.log('▸ Whisper model unloaded successfully')
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
