import {
  loadModel,
  textToSpeech,
  unloadModel,
  TTS_CODEC_DECODER_MOSS_TTS_F16,
  TTS_CODEC_ENCODER_MOSS_TTS_F16
} from '@qvac/sdk'
import { createWav } from './utils'

// MOSS-TTSD (GGML): multi-speaker dialogue in one pass, each voice cloned from
// a 24 kHz reference recording. The model continues the references, so the
// text opens with what each recording says under its speaker tag, followed by
// the lines to generate; only the new lines come out as audio. A dialogue is
// never split into sentences, so `stream: true` delivers the native chunks of
// the whole conversation (set `streamChunkTokens` to get them while it is
// still being generated).
//
// The MOSS-TTSD backbone is not in the QVAC Registry yet, so it is a local
// file; the codec halves it shares with MOSS-TTS download from the registry.
// Usage: node moss-dialogue.ts <moss-ttsd.gguf> <s1.wav> "<s1 transcript>" <s2.wav> "<s2 transcript>"
const [backbone, s1Audio, s1Text, s2Audio, s2Text] = process.argv.slice(2)
if (!backbone || !s1Audio || !s1Text || !s2Audio || !s2Text) {
  console.error(
    'Usage: node moss-dialogue.ts <moss-ttsd.gguf> <s1.wav> "<s1 transcript>" <s2.wav> "<s2 transcript>"'
  )
  process.exit(1)
}

// Only a fallback: the engine reports the rate it actually produced.
const MOSS_SAMPLE_RATE = 24000

try {
  const modelId = await loadModel({
    modelSrc: backbone,
    modelType: 'tts-ggml',
    modelConfig: {
      ttsEngine: 'moss',
      language: 'en',
      mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
      mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16,
      // One recording per speaker, in the order the text tags them.
      dialogueReferenceSrcs: [s1Audio, s2Audio],
      streamChunkTokens: 25,
      useGPU: true
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)

  console.log('▸ Synthesizing the dialogue...')
  const result = textToSpeech({
    modelId,
    text:
      `[S1] ${s1Text} [S2] ${s2Text} ` +
      '[S1] Did the build finish? [S2] Yes, every test passed. [S1] Great, ship it.',
    stream: true
  })

  const samples: number[] = []
  for await (const sample of result.bufferStream) samples.push(sample)

  const sampleRate = (await result.sampleRate) ?? MOSS_SAMPLE_RATE
  console.log(`▸ Dialogue complete: ${samples.length} samples`)

  createWav(samples, sampleRate, 'moss-dialogue-output.wav')
  console.log('▸ Audio saved to moss-dialogue-output.wav')

  await unloadModel({ modelId })
  console.log('▸ Model unloaded')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
