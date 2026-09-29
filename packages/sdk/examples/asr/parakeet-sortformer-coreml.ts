/**
 * Verify Sortformer v2.1 + Core ML sidecars on an Apple device.
 *
 * From packages/sdk:
 *   bun run examples/asr/parakeet-sortformer-coreml.ts [16-kHz-wav-file]
 *   QVAC_SORTFORMER_GGUF=/path/to/diar_streaming_sortformer_4spk-v2.1.q8_0.gguf \
 *     bun run examples/asr/parakeet-sortformer-coreml.ts
 *
 * The default audio is examples/audio/diarization-sample-16k.wav. The SDK
 * downloads the GGUF and both compiled encoder bundles from the registry.
 * The SDK currently omits encoder backend details from streaming stats. This
 * example checks the GGUF variant, both bundles, and diarization output.
 */
import {
  getModelInfo,
  loadModel,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  transcribeStream,
  unloadModel
} from '@qvac/sdk'
import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 16_000
const CHUNK_MS = 2_000
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS * 2) / 1_000
const defaultAudioPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'audio',
  'diarization-sample-16k.wav'
)
const audioPath = process.argv[2] ?? defaultAudioPath
const localModelPath = process.env['QVAC_SORTFORMER_GGUF']

const streamingConfig = {
  useGPU: true,
  streaming: true,
  streamingChunkMs: CHUNK_MS,
  streamingChunkRightContextMs: 560,
  streamingSpkCacheEnable: true,
  streamingSpkCacheLen: 188,
  streamingFifoLen: 188,
  streamingChunkLeftContextMs: 80,
  streamingSpkCacheUpdatePeriod: 144
} as const

function readPcm(wavPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        wavPath,
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '1',
        '-f',
        's16le',
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )

    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function assertAoscVariant(ggufPath: string): Promise<void> {
  const file = await open(ggufPath, 'r')
  try {
    const header = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (!header.subarray(0, bytesRead).includes(Buffer.from('sortformer-streaming-v2.1-aosc'))) {
      throw new Error(
        `The GGUF lacks Sortformer v2.1 AOSC metadata: ${ggufPath}. Regenerate and publish the GGUF before using its Core ML sidecars.`
      )
    }
  } finally {
    await file.close()
  }
}

let modelId: string | undefined

try {
  console.log('Loading Sortformer v2.1 with its Core ML encoder bundles...')
  modelId = await loadModel({
    modelSrc: localModelPath ?? PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
    modelType: 'parakeet-transcription',
    modelConfig: streamingConfig
  })

  let ggufPath = localModelPath
  if (localModelPath) {
    const stem = basename(localModelPath).replace(/\.(?:f16|q4_0|q8_0)\.gguf$/, '')
    for (const suffix of ['-encoder', '-encoder-bypass-pre-encode']) {
      await stat(
        join(dirname(localModelPath), `${stem}${suffix}.mlmodelc`, 'weights', 'weight.bin')
      )
    }
  } else {
    const modelInfo = await getModelInfo({ name: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0.name })
    ggufPath = modelInfo.cacheFiles.find(
      (file) => file.filename.endsWith('.gguf') && file.isCached
    )?.path
    const encoderWeights = modelInfo.cacheFiles.filter(
      (file) => file.filename.endsWith('.mlmodelc/weights/weight.bin') && file.isCached
    )
    if (!modelInfo.isCached || encoderWeights.length !== 2) {
      throw new Error('Both Sortformer Core ML encoder bundles must be cached beside the GGUF')
    }
  }
  if (!ggufPath) throw new Error('The Sortformer GGUF is missing from the SDK cache')
  await assertAoscVariant(ggufPath)
  console.log('Both Core ML encoder bundles are available.')

  const pcm = await readPcm(audioPath)
  const session = await transcribeStream({
    modelId,
    parakeetStreamingConfig: { chunkMs: CHUNK_MS }
  })

  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, pcm.length)
    session.write(pcm.subarray(offset, end))
    if (end < pcm.length) await wait(CHUNK_MS)
  }
  session.write(new Uint8Array((SAMPLE_RATE * 1_500 * 2) / 1_000))
  session.end()

  const speakerLines: string[] = []
  for await (const event of session) {
    if (event.type === 'text' && event.text.trim()) {
      const line = event.text.trim()
      speakerLines.push(line)
      console.log(line)
    }
  }

  const stats = await session.stats
  if (stats?.encoderOnCoreml !== undefined) {
    console.log(`Core ML encoder loaded: ${stats.encoderOnCoreml === 1 ? 'yes' : 'no'}`)
    if (stats.encoderOnCoreml !== 1) throw new Error('Sortformer ran without Core ML')
  }
  if (speakerLines.length === 0) {
    throw new Error('Sortformer emitted no speaker activity for the sample audio')
  }
  console.log('Sortformer Core ML example passed.')
} finally {
  if (modelId) await unloadModel({ modelId })
}
