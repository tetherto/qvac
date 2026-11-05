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
  getCoremlOnlyAlternative,
  getCoremlSidecarSpec,
  getRegistryModelPlatformRefusal,
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

// ---------------------------------------------------------------------------
// TranscribePsy: a Hugging Face family whose GGUF needs its bundles
// ---------------------------------------------------------------------------

const TRANSCRIBEPSY_COREML_DIR =
  'qvac/TranscribePsy-250M-EU-sub-coreml/resolve/929aa4a3df0ec24232fe206dce5e933caf072897/'
const TRANSCRIBEPSY_COREML_GGUF = `${TRANSCRIBEPSY_COREML_DIR}transcribepsy-250m-eu-sub-coreml.gguf`
const TRANSCRIBEPSY_GGUF =
  'qvac/TranscribePsy-250M-EU-sub-gguf/resolve/92460e0a8e7dc20f2fb126198bdd9eebb9ba2dc7/transcribepsy-250m-eu-sub.gguf'
const TRANSCRIBEPSY_BUNDLES = [
  'transcribepsy-250m-eu-sub-coreml-encoder',
  'transcribepsy-250m-eu-sub-coreml-decoder'
]

function transcribePsy(registryPath = TRANSCRIBEPSY_COREML_GGUF): RegistryItem {
  const filename = registryPath.split('/').pop()!
  return {
    name: 'TEST_TRANSCRIBEPSY',
    registryPath,
    registrySource: 'hf',
    modelId: filename,
    addon: 'parakeet',
    engine: 'parakeet-transcription',
    quantization: 'q8_0',
    params: '250M',
    expectedSize: 1000,
    sha256Checksum: 'd'.repeat(64),
    blobCoreKey: 'core-key',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
}

function hfBundle(name: string): QVACModelEntry[] {
  return COMPONENTS.map((component, index) => ({
    path: `${TRANSCRIBEPSY_COREML_DIR}${name}.mlmodelc/${component}`,
    source: 'hf',
    engine: '@qvac/transcription-parakeet',
    license: 'Apache-2.0',
    name: component,
    sizeBytes: index + 1,
    sha256: 'e'.repeat(64),
    blobBinding: {
      coreKey: 'sidecar-core',
      blockOffset: index,
      blockLength: 1,
      byteOffset: index,
      byteLength: index + 1,
      sha256: 'e'.repeat(64)
    }
  }))
}

test('Core ML sidecars: the TranscribePsy Core ML GGUF pairs with its encoder and decoder on Apple', (t) => {
  for (const platform of ['darwin', 'ios']) {
    const spec = getCoremlSidecarSpec(TRANSCRIBEPSY_COREML_GGUF, 'hf', platform)
    t.ok(spec, platform)
    t.is(spec?.source, 'hf')
    // The bundles sit in the GGUF's own repository revision, not a dated root.
    t.is(spec?.root, TRANSCRIBEPSY_COREML_DIR)
    t.is(spec?.modelStem, 'transcribepsy-250m-eu-sub-coreml')
    t.alike(
      spec?.bundles.map((bundle) => bundle.targetSuffix),
      ['-encoder', '-decoder']
    )
  }

  for (const platform of ['linux', 'win32', 'android', undefined]) {
    t.absent(getCoremlSidecarSpec(TRANSCRIBEPSY_COREML_GGUF, 'hf', platform), `${platform}`)
  }
  t.absent(getCoremlSidecarSpec(TRANSCRIBEPSY_COREML_GGUF, 's3', 'darwin'), 'published on hf only')
  t.absent(getCoremlSidecarSpec(TRANSCRIBEPSY_GGUF, 'hf', 'darwin'), 'the full GGUF has no sidecar')
})

test('Core ML sidecars: TranscribePsy stages both bundles under the names the addon looks for', async (t) => {
  const model = transcribePsy()
  const set = await findCoremlCompanionSet(
    client(TRANSCRIBEPSY_BUNDLES.flatMap(hfBundle)),
    model,
    'darwin'
  )

  t.ok(set)
  t.is(set!.files.length, 11)
  t.is(set!.files[0]!.targetName, 'transcribepsy-250m-eu-sub-coreml.gguf')
  t.ok(set!.files.slice(1).every((file) => file.registrySource === 'hf'))
  for (const bundle of TRANSCRIBEPSY_BUNDLES) {
    for (const component of COMPONENTS) {
      const file = set!.files.find((file) => file.targetName === `${bundle}.mlmodelc/${component}`)
      t.ok(file, `${bundle}/${component}`)
      t.is(file?.registryPath, `${TRANSCRIBEPSY_COREML_DIR}${bundle}.mlmodelc/${component}`)
    }
  }

  // The decoder weights live in the GGUF, so an encoder-only publication still
  // stages a usable set, as Sortformer's two bundles do.
  const encoderOnly = await findCoremlCompanionSet(
    client(hfBundle(TRANSCRIBEPSY_BUNDLES[0]!)),
    model,
    'ios'
  )
  t.is(encoderOnly?.files.length, 6)
})

test('Core ML sidecars: a cached TranscribePsy set round-trips with its hf source', async (t) => {
  const model = transcribePsy()
  const set = await findCoremlCompanionSet(
    client(TRANSCRIBEPSY_BUNDLES.flatMap(hfBundle)),
    model,
    'darwin'
  )
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
    t.is(cached?.files.length, 11)

    // A set recorded from another registry source does not describe this model.
    const foreign = {
      ...set!,
      files: set!.files.map((file) =>
        file.key === 'modelPath' ? file : { ...file, registrySource: 's3' }
      )
    }
    await writeCachedCoremlCompanionSet(foreign, cacheDir)
    t.absent(await readCachedCoremlCompanionSet(model, 'darwin', cacheDir))
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Core ML sidecars: the generated catalog describes the TranscribePsy distribution', (t) => {
  const coreml = models.find((entry) => entry.name === 'PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0')
  t.ok(coreml)
  const set = findCatalogCoremlCompanionSet(coreml!, 'darwin')
  t.is(set?.files.length, 11)
  t.ok(
    set?.files.some(
      (file) => file.targetName === 'transcribepsy-250m-eu-sub-coreml-decoder.mlmodelc/model.mil'
    )
  )
  t.absent(findCatalogCoremlCompanionSet(coreml!, 'linux'))

  const full = models.find((entry) => entry.name === 'PARAKEET_TRANSCRIBEPSY_250M_Q8_0')
  t.ok(full)
  t.absent(findCatalogCoremlCompanionSet(full!, 'darwin'), 'the full GGUF runs on ggml')
})

test('Core ML sidecars: the encoder-less GGUF is refused off Apple with the ggml alternative', (t) => {
  t.is(
    getCoremlOnlyAlternative(TRANSCRIBEPSY_COREML_GGUF, 'hf'),
    'PARAKEET_TRANSCRIBEPSY_250M_Q8_0'
  )
  t.absent(getCoremlOnlyAlternative(TRANSCRIBEPSY_GGUF, 'hf'))
  t.absent(
    getCoremlOnlyAlternative(`${AUDIO8_GGUF_DIR}audio8-codec-decoder-q8_0.gguf`, 's3'),
    'a GGUF that merely gains a sidecar loads everywhere'
  )

  const coremlSrc = `registry://hf/${TRANSCRIBEPSY_COREML_GGUF}`
  for (const platform of ['linux', 'win32', 'android', undefined]) {
    const refusal = getRegistryModelPlatformRefusal(coremlSrc, platform)
    t.ok(refusal, `${platform}`)
    t.ok(refusal!.includes('transcribepsy-250m-eu-sub-coreml.gguf'))
    t.ok(refusal!.includes('PARAKEET_TRANSCRIBEPSY_250M_Q8_0'))
  }
  // A model constant object carries the same source.
  t.ok(getRegistryModelPlatformRefusal({ src: coremlSrc, name: 'X' }, 'linux'))

  t.absent(getRegistryModelPlatformRefusal(coremlSrc, 'darwin'))
  t.absent(getRegistryModelPlatformRefusal(coremlSrc, 'ios'))
  t.absent(getRegistryModelPlatformRefusal(`registry://hf/${TRANSCRIBEPSY_GGUF}`, 'linux'))
  t.absent(
    getRegistryModelPlatformRefusal('/models/transcribepsy-250m-eu-sub-coreml.gguf', 'linux')
  )
  t.absent(getRegistryModelPlatformRefusal('', 'linux'))
})
