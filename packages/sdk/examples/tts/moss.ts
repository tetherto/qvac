import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_DELAY_LLM_MOSS_TTS_F16,
  TTS_CODEC_DECODER_MOSS_TTS_F16,
  TTS_CODEC_ENCODER_MOSS_TTS_F16
} from '@qvac/sdk'
import { createWav } from './utils'

// MOSS (GGML): OpenMOSS MOSS-TTS v1.5 Delay, an 8B backbone (about 17 GB)
// plus a codec, so desktop only. The primary modelSrc is the backbone; the
// codec decoder loads via modelConfig, and the codec encoder is only needed to
// clone a voice from a 24 kHz reference recording (no transcript needed).
//
// MOSS streams natively: with `streamChunkTokens` set, `stream: true` emits a
// chunk every that-many codec frames (12.5 per second) while the backbone is
// still generating, and the text is synthesized as one utterance, so the
// `[pause 1.0s]` marker below and `durationTokens` apply to all of it.
//
// Uses registry model constants — downloads automatically from QVAC Registry.
// Usage: node moss.ts [referenceAudio.wav]
const [referenceAudioSrc] = process.argv.slice(2)

// Only a fallback: the engine reports the rate it actually produced.
const MOSS_SAMPLE_RATE = 24000

try {
  const modelId = await loadModel({
    modelSrc: TTS_DELAY_LLM_MOSS_TTS_F16,
    modelConfig: {
      ttsEngine: 'moss',
      language: 'en',
      mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
      ...(referenceAudioSrc
        ? { mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16, referenceAudioSrc }
        : {}),
      streamChunkTokens: 25,
      useGPU: true,
      seed: 7
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)

  console.log('▸ Streaming MOSS Text-to-Speech...')
  const started = Date.now()
  const result = textToSpeech({
    modelId,
    text: 'Hold on [pause 1.0s] here it comes: speech that starts playing while the rest is still being generated.',
    stream: true
  })

  const samples: number[] = []
  for await (const sample of result.bufferStream) {
    if (samples.length === 0) console.log(`▸ First audio after ${Date.now() - started} ms`)
    samples.push(sample)
  }

  const sampleRate = (await result.sampleRate) ?? MOSS_SAMPLE_RATE
  const stats = await result.stats
  console.log(
    `▸ TTS complete: ${samples.length} samples, ${stats?.generatedFrames ?? '?'} codec frames, RTF ${stats?.realTimeFactor?.toFixed(2) ?? '?'}`
  )

  createWav(samples, sampleRate, 'moss-output.wav')
  console.log('▸ Audio saved to moss-output.wav')

  await unloadModel({ modelId })
  console.log('▸ Model unloaded')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
