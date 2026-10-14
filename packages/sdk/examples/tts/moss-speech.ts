import {
  loadModel,
  textToSpeech,
  unloadModel,
  close,
  TTS_MOSS_SPEECH_Q8_0,
  TTS_CODEC_MOSS_SPEECH_F16,
  type ModelProgressUpdate
} from '@qvac/sdk'

// Desktop MOSS-Speech: answer a typed question with textReply: true.
// This mode skips audio decoding and returns text with an empty PCM buffer.
// Run from packages/sdk: node --import tsx examples/tts/moss-speech.ts
// Use a GPU with enough memory. Registry sources download automatically.
// Optional local paths: QVAC_MOSS_SPEECH_MODEL and QVAC_MOSS_SPEECH_CODEC.
// Both engines run a batch job; stream: false collects the complete reply.

let lastPercentage = -1
function progress(p: ModelProgressUpdate) {
  const percentage = Math.floor(p.percentage)
  if (percentage === lastPercentage) return
  lastPercentage = percentage
  const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${(p.downloaded / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB)`
  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
  if (p.percentage >= 100) process.stderr.write('\n')
}

async function main() {
  const modelId = await loadModel({
    modelSrc: process.env['QVAC_MOSS_SPEECH_MODEL'] ?? TTS_MOSS_SPEECH_Q8_0,
    modelType: 'tts-ggml',
    modelConfig: {
      ttsEngine: 'moss-speech',
      mossSpeechCodecModelSrc: process.env['QVAC_MOSS_SPEECH_CODEC'] ?? TTS_CODEC_MOSS_SPEECH_F16,
      useGPU: true,
      seed: 42
    },
    onProgress: progress
  })
  try {
    console.error('▸ Generating a text-only reply...')
    const result = textToSpeech({
      modelId,
      text: 'What is two plus two? Answer in one short sentence.',
      stream: false,
      textReply: true,
      greedy: true,
      maxNewTokens: 128,
      maxReplySeconds: 5,
      systemPrompt: 'You are a helpful assistant. Give short, direct answers.'
    })
    const samples = await result.buffer
    const reply = await result.text
    if (!(await result.done) || !reply?.trim()) throw new Error('The model returned no reply text.')
    console.log(reply)
    if (samples.length !== 0) throw new Error('A text-only reply must not contain PCM audio.')
  } finally {
    await unloadModel({ modelId })
  }
}

try {
  await main()
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch (error) {
    console.error('✖ Cleanup failed:', error)
    process.exitCode = 1
  }
}
