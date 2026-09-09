/**
 * Nemotron 3.5 ASR batch or cache-aware streaming transcription from a file.
 *
 * Usage:
 *   bun run examples/asr/parakeet-nemotron-filesystem.ts \
 *     <audio-file> <nemotron-gguf> [locale] [--streaming]
 *
 * `locale` defaults to `auto`; examples include `en-US` and `hi-IN`.
 * Streaming deliberately leaves the engine cadence unset so Nemotron uses its
 * model-specific 320 ms default. FFmpeg is required for streaming input.
 */
import { loadModel, transcribe, transcribeStream, unloadModel } from '@qvac/sdk'
import { spawn } from 'child_process'

const SAMPLE_RATE = 16000
const BYTES_PER_S16_SAMPLE = 2
const INPUT_CHUNK_MS = 160

const args = process.argv.slice(2)
const streaming = args.includes('--streaming')
const positional = args.filter((argument) => !argument.startsWith('--'))
const [audioFilePath, nemotronModelSrc, locale = 'auto'] = positional

if (!audioFilePath || !nemotronModelSrc) {
  console.error(
    'Usage: bun run examples/asr/parakeet-nemotron-filesystem.ts ' +
      '<audio-file> <nemotron-gguf> [locale] [--streaming]'
  )
  process.exit(1)
}

const inputPath = audioFilePath
const modelSrc = nemotronModelSrc

function decodeToS16le(path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const ffmpeg = spawn(
      'ffmpeg',
      ['-i', path, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )

    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`))
        return
      }

      const pcm = Buffer.concat(chunks)
      resolve(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runStreaming(modelId: string): Promise<void> {
  const pcm = await decodeToS16le(inputPath)
  const chunkBytes = Math.floor((INPUT_CHUNK_MS / 1000) * SAMPLE_RATE) * BYTES_PER_S16_SAMPLE

  // No parakeetStreamingConfig.chunkMs override: the addon reads the Nemotron
  // metadata and selects its trained 320 ms operating point.
  const session = await transcribeStream({ modelId, parakeetStreamingConfig: {} })

  try {
    const output = (async () => {
      for await (const event of session) {
        if (event.type === 'text' && event.text) process.stdout.write(event.text)
      }
    })()

    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const end = Math.min(offset + chunkBytes, pcm.length)
      session.write(pcm.subarray(offset, end))
      if (end < pcm.length) await delay(INPUT_CHUNK_MS)
    }

    session.end()
    await output
    process.stdout.write('\n')
  } finally {
    // Safe after normal iteration and necessary if feeding or decoding fails.
    session.destroy()
  }
}

let modelId: string | null = null

try {
  console.log(`▸ Loading Nemotron with locale ${locale}...`)
  modelId = await loadModel({
    modelSrc,
    modelType: 'parakeet-transcription',
    modelConfig: {
      language: locale,
      streaming
      // Do not set streamingChunkMs: Nemotron selects 320 ms natively.
    }
  })

  if (streaming) {
    console.log('▸ Streaming with Nemotron’s native 320 ms operating point...')
    await runStreaming(modelId)
  } else {
    console.log('▸ Transcribing in batch mode...')
    console.log(await transcribe({ modelId, audioChunk: inputPath }))
  }
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) await unloadModel({ modelId })
}
