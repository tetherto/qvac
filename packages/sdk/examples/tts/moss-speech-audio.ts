import { readFileSync, writeFileSync } from 'node:fs'
import {
  loadModel,
  textToSpeech,
  unloadModel,
  close,
  TTS_MOSS_SPEECH_Q8_0,
  TTS_CODEC_MOSS_SPEECH_F16,
  type ModelProgressUpdate
} from '@qvac/sdk'

// Desktop MOSS-Speech: 9B language model + codec, 24 kHz spoken reply and text.
// Run from packages/sdk: node --import tsx examples/tts/moss-speech-audio.ts question.wav
// Use a GPU with enough memory. Registry sources download automatically.
// Optional local paths: QVAC_MOSS_SPEECH_MODEL and QVAC_MOSS_SPEECH_CODEC.
// Both engines run a batch job; stream: false collects the complete reply.

function saveWav(samples: number[], sampleRate: number, filename: string) {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('The model returned no usable audio.')
  }
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]!))), 44 + i * 2)
  }
  writeFileSync(filename, wav)
  console.error(
    `▸ Saved ${filename}: ${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(2)} seconds`
  )
}

let lastPercentage = -1
function progress(p: ModelProgressUpdate) {
  const percentage = Math.floor(p.percentage)
  if (percentage === lastPercentage) return
  lastPercentage = percentage
  const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${(p.downloaded / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB)`
  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
  if (p.percentage >= 100) process.stderr.write('\n')
}

// Read standard mono/stereo PCM16 or float32 WAV without an audio-library dependency.
function readQuestion(filename: string) {
  const wav = readFileSync(filename)
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Question must be a RIFF WAV file.')
  }
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | undefined
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > wav.length) throw new Error('Truncated WAV chunk.')
    const id = wav.toString('ascii', offset, offset + 4)
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format chunk.')
      format = wav.readUInt16LE(start)
      channels = wav.readUInt16LE(start + 2)
      sampleRate = wav.readUInt32LE(start + 4)
      bits = wav.readUInt16LE(start + 14)
    } else if (id === 'data') data = wav.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  if (
    !data ||
    ![1, 2].includes(channels) ||
    !((format === 1 && bits === 16) || (format === 3 && bits === 32))
  ) {
    throw new Error('Use a mono/stereo PCM16 or float32 WAV question.')
  }
  if (sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('WAV sample rate must be 8000–192000 Hz.')
  }
  const bytesPerSample = bits / 8
  const frameBytes = bytesPerSample * channels
  if (data.length % frameBytes !== 0) throw new Error('Incomplete WAV audio frame.')
  const audio: number[] = []
  for (let offset = 0; offset < data.length; offset += frameBytes) {
    let sample = 0
    for (let channel = 0; channel < channels; channel++) {
      const at = offset + channel * bytesPerSample
      sample += format === 1 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at)
    }
    audio.push(sample / channels)
  }
  if (audio.length === 0 || audio.length > sampleRate * 60) {
    throw new Error('Use a non-empty question of at most 60 seconds.')
  }
  return { audio, sampleRate }
}

async function main() {
  const filename = process.argv[2]
  if (!filename) {
    throw new Error('Usage: node --import tsx examples/tts/moss-speech-audio.ts question.wav')
  }
  const question = readQuestion(filename)
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
    console.error('▸ Generating a spoken reply...')
    const result = textToSpeech({
      modelId,
      ...question,
      stream: false,
      greedy: true,
      maxNewTokens: 128,
      maxReplySeconds: 5,
      messages: [{ role: 'user', text: 'Please answer the next spoken turn briefly.' }]
    })
    const samples = await result.buffer
    const reply = await result.text
    if (!(await result.done)) throw new Error('Speech generation did not complete.')
    if (reply?.trim()) console.log(reply)
    else console.error('▸ The model returned an audio-only reply.')
    const sampleRate = await result.sampleRate
    if (sampleRate !== 24000) throw new Error(`Unexpected reply sample rate: ${sampleRate}`)
    saveWav(samples, sampleRate, 'moss-speech-audio-output.wav')
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
