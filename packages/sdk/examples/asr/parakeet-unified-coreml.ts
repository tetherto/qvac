/**
 * Transcribe a WAV file with Parakeet Unified and its Core ML encoder sidecar.
 *
 * From packages/sdk:
 *   npx tsx examples/asr/parakeet-unified-coreml.ts \
 *     /path/to/parakeet-unified-en-0.6b.q4_0.gguf [16-kHz-wav-file]
 *
 * The GGUF must be a regenerated Unified artifact. The five compiled Core ML
 * files are downloaded through the SDK registry and staged beside the GGUF.
 * The default audio is examples/audio/sample-16khz.wav.
 */
import { downloadAsset, getModelInfo, loadModel, transcribe, unloadModel } from '@qvac/sdk'
import { link, mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL_STEM = 'parakeet-unified-en-0.6b'
const COREML_FILES = [
  ['PARAKEET_UNIFIED_COREMLDATA', 'analytics/coremldata.bin'],
  ['PARAKEET_UNIFIED_COREMLDATA_1', 'coremldata.bin'],
  ['PARAKEET_UNIFIED_METADATA', 'metadata.json'],
  ['PARAKEET_UNIFIED_MODEL', 'model.mil'],
  ['PARAKEET_UNIFIED_WEIGHT', 'weights/weight.bin']
] as const

const defaultAudioPath = fileURLToPath(new URL('../audio/sample-16khz.wav', import.meta.url))
const modelPath = process.argv[2]
const audioPath = process.argv[3] ?? defaultAudioPath

async function checkModel(path: string): Promise<void> {
  const name = basename(path)
  if (!/^parakeet-unified-en-0\.6b\.(?:f16|q4_0|q8_0)\.gguf$/.test(name)) {
    throw new Error(`Expected a regenerated Unified GGUF, got: ${name}`)
  }

  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (!header.subarray(0, bytesRead).includes('parakeet.unified.left_context_frames')) {
      throw new Error(`Unified GGUF lacks the new streaming metadata: ${path}`)
    }
  } finally {
    await file.close()
  }
}

async function stageModel(path: string): Promise<{ modelSrc: string; dir: string }> {
  if (process.platform !== 'darwin') throw new Error('Core ML requires macOS')
  await checkModel(path)

  const dir = await mkdtemp(join(tmpdir(), 'qvac-unified-coreml-'))
  try {
    const modelSrc = join(dir, basename(path))
    await symlink(resolve(path), modelSrc)
    const bundleDir = join(dir, `${MODEL_STEM}-encoder.mlmodelc`)

    for (const [name, relativePath] of COREML_FILES) {
      const info = await getModelInfo({ name })
      if (!info.isCached) {
        if (!info.registrySource || !info.registryPath) {
          throw new Error(`Registry location missing for ${name}`)
        }
        console.log(`▸ Downloading Core ML ${relativePath}...`)
        await downloadAsset({ assetSrc: `registry://${info.registrySource}/${info.registryPath}` })
      }

      const cached = await getModelInfo({ name })
      const sourcePath = cached.cacheFiles.find((file) => file.isCached)?.path
      if (!sourcePath) throw new Error(`Core ML file is missing from the SDK cache: ${name}`)

      const targetPath = join(bundleDir, relativePath)
      await mkdir(join(targetPath, '..'), { recursive: true })
      await link(sourcePath, targetPath)
    }

    return { modelSrc, dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

async function main(): Promise<void> {
  if (!modelPath) {
    throw new Error(
      'Usage: npx tsx examples/asr/parakeet-unified-coreml.ts ' +
        '<regenerated-unified-gguf> [16-kHz-wav-file]'
    )
  }

  let staged: Awaited<ReturnType<typeof stageModel>> | undefined
  let modelId: string | undefined
  try {
    staged = await stageModel(modelPath)
    console.log('▸ Loading Parakeet Unified with its Core ML encoder sidecar...')
    modelId = await loadModel({
      modelSrc: staged.modelSrc,
      modelType: 'parakeet-transcription',
      modelConfig: { useGPU: true }
    })

    console.log('▸ Transcribing audio...')
    const text = await transcribe({ modelId, audioChunk: audioPath })
    if (!text.trim()) throw new Error('Parakeet Unified returned an empty transcription')
    console.log(text)
  } finally {
    try {
      if (modelId) await unloadModel({ modelId })
    } finally {
      if (staged) await rm(staged.dir, { recursive: true, force: true })
    }
  }
}

main().catch((error: unknown) => {
  console.error('✖', error)
  process.exitCode = 1
})
