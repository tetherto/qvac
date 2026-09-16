import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioUnderstand,
  loadModel,
  unloadModel
} from '@qvac/sdk'

// Describe an existing recording with ACE-Step's reverse pipeline: the engine
// encodes the audio, recovers its FSQ semantic codes, and the LM reports a
// caption and the clip's musical metadata.
//
// Usage:
//   bun examples/audiogen/understand-music.ts <source.wav|mp3|...> [language hint]
//
// The source is a file path: the SDK decodes it (any FFmpeg-decodable format)
// to the 48 kHz stereo float PCM the engine expects. Pass raw interleaved
// stereo 48 kHz Float32 LE PCM in [-1, 1] as a Buffer instead when the audio
// is already in memory.
const sourcePath = process.argv[2]
const vocalLanguage = process.argv[3]

if (!sourcePath) {
  console.error('Usage: bun examples/audiogen/understand-music.ts <source-audio> [language]')
  process.exit(1)
}

let modelId: string | undefined

try {
  console.log('▸ Loading ACE-Step AudioGen models...')
  modelId = await loadModel({
    modelType: 'audiogen',
    modelConfig: {
      textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
      lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
      ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
      vaeModelSrc: AUDIOGEN_VAE_BF16,
      useGPU: true
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Analysing ${sourcePath}`)

  const run = audioUnderstand({
    modelId,
    sourceAudio: sourcePath,
    // Forced into the result instead of the LM's guess; omit to let it decide.
    ...(vocalLanguage !== undefined && { vocalLanguage }),
    seed: 11
  })
  console.log(`▸ requestId: ${run.requestId}`)

  for await (const progress of run.progressStream) {
    const value =
      progress.total > 0 ? `${progress.step}/${progress.total}` : `${progress.step} (indeterminate)`
    console.log(`▸ ${progress.stage}: ${value}`)
  }

  const [description, stats] = await Promise.all([run.description, run.stats])
  console.log(`▸ Caption: ${description.caption}`)
  console.log(`▸ ${description.bpm} BPM, ${description.keyscale}, ${description.timesignature}`)
  console.log(`▸ Vocal language: ${description.vocalLanguage}`)
  // The LM's duration is an estimate; the recovered codes fix the true length.
  console.log(`▸ Estimated duration: ${description.duration.toFixed(1)} s`)
  console.log(`▸ Recovered ${description.audioCodes.length} semantic codes`)
  if (stats) console.log(`▸ Stats: ${JSON.stringify({ ...stats, understand: undefined })}`)

  // `audioCodes` feeds straight back into audioGen() to re-synthesize the piece
  // without re-running the LM:
  //   audioGen({ modelId, caption: description.caption, audioCodes: description.audioCodes })

  await unloadModel({ modelId })
  modelId = undefined
  process.exit(0)
} catch (error) {
  if (modelId !== undefined) {
    try {
      await unloadModel({ modelId })
    } catch {
      // Preserve the understand error as the primary failure.
    }
  }
  console.error('✖', error)
  process.exit(1)
}
