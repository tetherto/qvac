import test from 'brittle'
import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import { models, type RegistryItem } from '@/models/registry/models'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import {
  findCoremlCompanionSet,
  findCatalogCoremlCompanionSet,
  findLocallyCachedCoremlCompanionSet,
  getCoremlSidecarSpec,
  readCachedCoremlCompanionSet,
  writeCachedCoremlCompanionSet
} from '@/handlers/load-model/coreml-sidecars'

const AUDIO8_ROOT = 'qvac_models_compiled/ggml/audio8/2026-09-30/'
const AUDIO8_GGUF_DIR = 'qvac_models_compiled/ggml/audio-8/2026-08-12/'
const COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
]

function audio8(filename: string): RegistryItem {
  return {
    name: 'TEST_AUDIO8',
    registryPath: `${AUDIO8_GGUF_DIR}${filename}`,
    registrySource: 's3',
    modelId: filename,
    addon: 'tts',
    engine: 'tts-ggml',
    quantization: 'q8_0',
    params: '0.6B',
    expectedSize: 1000,
    sha256Checksum: 'a'.repeat(64),
    blobCoreKey: 'core-key',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
}

function bundle(name: string): QVACModelEntry[] {
  return COMPONENTS.map((component, index) => ({
    path: `${AUDIO8_ROOT}${name}.mlmodelc/${component}`,
    source: 's3',
    engine: '@qvac/tts-ggml',
    license: 'Apache-2.0',
    name: component,
    sizeBytes: index + 1,
    sha256: 'b'.repeat(64),
    blobBinding: {
      coreKey: 'sidecar-core',
      blockOffset: index,
      blockLength: 1,
      byteOffset: index,
      byteLength: index + 1,
      sha256: 'b'.repeat(64)
    }
  }))
}

function client(entries: QVACModelEntry[]): Pick<QVACRegistryClient, 'findModels'> {
  return {
    findModels: async (query) =>
      entries.filter(
        (entry) => entry.path >= (query?.gte?.path ?? '') && entry.path <= (query?.lte?.path ?? '')
      )
  } as Pick<QVACRegistryClient, 'findModels'>
}

test('Core ML sidecars: the Audio8 codec decoder is staged beside its bundle on Apple', async (t) => {
  const set = await findCoremlCompanionSet(
    client(bundle('audio8-codec-decoder')),
    audio8('audio8-codec-decoder-q8_0.gguf'),
    'darwin'
  )

  t.ok(set)
  t.is(set!.primaryKey, 'modelPath')
  t.is(set!.files.length, 6)
  t.is(set!.files[0]!.targetName, 'audio8-codec-decoder-q8_0.gguf')
  t.is(set!.files[0]!.primary, true)
  // The addon looks for the bundle under the tier-less name next to the GGUF.
  t.alike(
    set!.files.slice(1).map((file) => file.targetName),
    COMPONENTS.map((component) => `audio8-codec-decoder.mlmodelc/${component}`)
  )
  t.is(
    set!.files[5]!.registryPath,
    `${AUDIO8_ROOT}audio8-codec-decoder.mlmodelc/weights/weight.bin`
  )
  t.is(set!.files[5]!.expectedSize, 5)
})

test('Core ML sidecars: every Audio8 decoder tier shares the one bundle in its own set', async (t) => {
  const registry = client(bundle('audio8-codec-decoder'))
  const q8 = await findCoremlCompanionSet(registry, audio8('audio8-codec-decoder-q8_0.gguf'), 'ios')
  const f16 = await findCoremlCompanionSet(registry, audio8('audio8-codec-decoder-f16.gguf'), 'ios')

  t.ok(q8)
  t.ok(f16)
  t.is(f16!.files[0]!.targetName, 'audio8-codec-decoder-f16.gguf')
  t.alike(
    f16!.files.slice(1).map((file) => file.registryPath),
    q8!.files.slice(1).map((file) => file.registryPath)
  )
  t.not(f16!.setKey, q8!.setKey, 'each GGUF gets its own directory')
})

test('Core ML sidecars: other Audio8 GGUFs and non-Apple platforms get no sidecar', (t) => {
  const decoder = `${AUDIO8_GGUF_DIR}audio8-codec-decoder-q8_0.gguf`
  t.ok(getCoremlSidecarSpec(decoder, 's3', 'darwin'))
  t.ok(getCoremlSidecarSpec(decoder, 's3', 'ios'))

  for (const platform of ['linux', 'win32', 'android', undefined]) {
    t.absent(getCoremlSidecarSpec(decoder, 's3', platform), `${platform}`)
  }
  t.absent(getCoremlSidecarSpec(decoder, 'hf', 'darwin'), 'only the s3 registry publishes it')
  t.absent(getCoremlSidecarSpec(`${AUDIO8_GGUF_DIR}audio8-lm-q8_0.gguf`, 's3', 'darwin'))
  t.absent(getCoremlSidecarSpec(`${AUDIO8_GGUF_DIR}audio8-codec-encoder-q8_0.gguf`, 's3', 'darwin'))
  t.absent(getCoremlSidecarSpec('other/audio8-codec-decoder-q8_0.gguf', 's3', 'darwin'))
})

test('Core ML sidecars: an incomplete bundle keeps GGUF-only loading', async (t) => {
  const model = audio8('audio8-codec-decoder-q8_0.gguf')
  const incomplete = bundle('audio8-codec-decoder').slice(0, 4)

  t.absent(await findCoremlCompanionSet(client(incomplete), model, 'darwin'))
  t.absent(await findCoremlCompanionSet(client([]), model, 'darwin'))
})

test('Core ML sidecars: a complete cached set is reused without registry discovery', async (t) => {
  const model = audio8('audio8-codec-decoder-q8_0.gguf')
  const set = await findCoremlCompanionSet(client(bundle('audio8-codec-decoder')), model, 'darwin')
  t.ok(set)

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-coreml-cache-'))
  try {
    for (const file of set!.files) {
      const filePath = path.join(cacheDir, 'sets', set!.setKey, file.targetName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, Buffer.alloc(file.expectedSize))
    }
    await writeCachedCoremlCompanionSet(set!, cacheDir)

    const cached = await findLocallyCachedCoremlCompanionSet(model, 'darwin', cacheDir)
    t.is(cached?.setKey, set!.setKey)
    t.alike(
      cached?.files.map((file) => file.targetName),
      set!.files.map((file) => file.targetName)
    )
    t.absent(
      await findLocallyCachedCoremlCompanionSet(model, 'linux', cacheDir),
      'a non-Apple host ignores the set'
    )

    fs.rmSync(path.join(cacheDir, 'sets', set!.setKey, set!.files[5]!.targetName))
    t.absent(await findLocallyCachedCoremlCompanionSet(model, 'darwin', cacheDir))
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Core ML sidecars: cached metadata for a different GGUF is not reused', async (t) => {
  const model = audio8('audio8-codec-decoder-q8_0.gguf')
  const set = await findCoremlCompanionSet(client(bundle('audio8-codec-decoder')), model, 'darwin')
  t.ok(set)

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-coreml-cache-'))
  try {
    await writeCachedCoremlCompanionSet(set!, cacheDir)
    // Same path, republished weights: the cached set no longer describes it.
    const republished = { ...model, sha256Checksum: 'c'.repeat(64) }
    t.ok(await readCachedCoremlCompanionSet(model, 'darwin', cacheDir))
    t.absent(await readCachedCoremlCompanionSet(republished, 'darwin', cacheDir))
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Core ML sidecars: the generated catalog describes the Audio8 bundle', (t) => {
  for (const name of ['TTS_CODEC_DECODER_AUDIO8_Q8_0', 'TTS_CODEC_DECODER_AUDIO8_FP16']) {
    const model = models.find((entry) => entry.name === name)
    t.ok(model, name)
    const set = findCatalogCoremlCompanionSet(model!, 'darwin')
    t.is(set?.files.length, 6, `${name} pairs with all five components`)
    t.is(set?.files[5]?.targetName, 'audio8-codec-decoder.mlmodelc/weights/weight.bin')
    t.absent(findCatalogCoremlCompanionSet(model!, 'android'))
  }
})
