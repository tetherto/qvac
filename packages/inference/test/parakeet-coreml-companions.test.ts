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
  writeCachedCoremlCompanionSet
} from '@/handlers/load-model/coreml-sidecars'

const ROOT = 'qvac_models_compiled/ggml/parakeet/2026-09-28/'
const COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
]

function primary(filename: string): RegistryItem {
  return {
    name: 'TEST_PARAKEET',
    registryPath: `qvac_models_compiled/ggml/parakeet/2026-05-11/${filename}`,
    registrySource: 's3',
    modelId: filename,
    addon: 'parakeet',
    engine: 'parakeet-transcription',
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
    path: `${ROOT}${name}.mlmodelc/${component}`,
    source: 's3',
    engine: '@qvac/transcription-parakeet',
    license: 'CC-BY-4.0',
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

test('Core ML companions: Apple TDT uses one GGUF constant and a colocated encoder bundle', async (t) => {
  const model = primary('parakeet-tdt-0.6b-v3.q8_0.gguf')
  const set = await findCoremlCompanionSet(
    client(bundle('parakeet-tdt-0.6b-v3-encoder')),
    model,
    'darwin'
  )

  t.ok(set)
  t.is(set!.files.length, 6)
  t.is(set!.files[0]!.targetName, 'parakeet-tdt-0.6b-v3.q8_0.gguf')
  t.is(set!.files[5]!.targetName, 'parakeet-tdt-0.6b-v3-encoder.mlmodelc/weights/weight.bin')
  t.is(
    set!.files[5]!.registryPath,
    `${ROOT}parakeet-tdt-0.6b-v3-encoder.mlmodelc/weights/weight.bin`
  )
})

test('Core ML companions: EOU source name is mapped to the GGUF-derived name', async (t) => {
  const set = await findCoremlCompanionSet(
    client(bundle('parakeet_realtime_eou_120m-v1-encoder')),
    primary('parakeet-eou-120m-v1.q8_0.gguf'),
    'ios'
  )

  t.ok(set)
  t.is(set!.files[1]!.targetName, 'parakeet-eou-120m-v1-encoder.mlmodelc/analytics/coremldata.bin')
})

test('Core ML companions: Sortformer stages both batch and AOSC bundles', async (t) => {
  const source = 'diar_streaming_sortformer_4spk-v2.1'
  const set = await findCoremlCompanionSet(
    client([...bundle(`${source}-encoder`), ...bundle(`${source}-encoder-bypass-pre-encode`)]),
    primary(`${source}.f16.gguf`),
    'darwin'
  )

  t.ok(set)
  t.is(set!.files.length, 11)
  t.ok(
    set!.files.some((file) =>
      file.targetName.endsWith('-encoder-bypass-pre-encode.mlmodelc/weights/weight.bin')
    )
  )
})

test('Core ML companions: incomplete bundles and non-Apple platforms keep GGUF-only loading', async (t) => {
  const model = primary('parakeet-tdt-0.6b-v3.q8_0.gguf')
  const incomplete = bundle('parakeet-tdt-0.6b-v3-encoder').slice(0, 4)

  t.absent(await findCoremlCompanionSet(client(incomplete), model, 'darwin'))
  t.absent(
    await findCoremlCompanionSet(
      client(bundle('parakeet-tdt-0.6b-v3-encoder')),
      model,
      'linux'
    )
  )
  t.absent(getCoremlSidecarSpec(model.registryPath, 's3', 'android'))
  t.absent(getCoremlSidecarSpec('other/parakeet-tdt-0.6b-v3.q8_0.gguf', 's3', 'ios'))
})

test('Core ML companions: a complete cached set is available without registry discovery', async (t) => {
  const model = primary('parakeet-tdt-0.6b-v3.q8_0.gguf')
  const set = await findCoremlCompanionSet(
    client(bundle('parakeet-tdt-0.6b-v3-encoder')),
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
    t.alike(
      cached?.files.map((file) => file.targetName),
      set!.files.map((file) => file.targetName)
    )

    fs.rmSync(path.join(cacheDir, 'sets', set!.setKey, set!.files[1]!.targetName))
    t.absent(await findLocallyCachedCoremlCompanionSet(model, 'darwin', cacheDir))
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Core ML companions: generated catalog can describe a previously downloaded set', (t) => {
  const model = models.find((entry) => entry.name === 'PARAKEET_UNIFIED_0_6B_Q4_0')
  t.ok(model)
  const set = findCatalogCoremlCompanionSet(model!, 'darwin')
  t.is(set?.files.length, 6)
  t.is(
    set?.files[1]?.targetName,
    'parakeet-unified-en-0.6b-encoder.mlmodelc/analytics/coremldata.bin'
  )
})
