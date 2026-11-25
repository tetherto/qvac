import test from 'brittle'
import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import type { RegistryItem } from '@/models/registry/models'
import {
  findCatalogCoremlBundleSet,
  findRegistryCoremlBundleSet,
  getCoremlBundle,
  getCoremlBundleDir,
  getCoremlBundleSetKey,
  readCachedCoremlBundleSet,
  writeCachedCoremlBundleSet
} from '@/handlers/load-model/coreml-bundle'
import { coremlBundleNameOf } from '@/utils/cache/layout'

const ROOT = 'qvac_models_compiled/ggml/stable-diffusion/2026-11-19/'
const SD_COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
]
// The SDXL chunk bundles carry no metadata.json.
const CHUNK_COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'model.mil',
  'weights/weight.bin'
]

function entries(bundlePath: string, components = SD_COMPONENTS, source = 's3'): QVACModelEntry[] {
  return components.map((component, index) => ({
    path: `${bundlePath}/${component}`,
    source,
    engine: '@qvac/diffusion-cpp',
    license: 'MIT',
    name: component,
    sizeBytes: index + 1,
    sha256: 'b'.repeat(64),
    blobBinding: {
      coreKey: 'bundle-core',
      blockOffset: index,
      blockLength: 1,
      byteOffset: index,
      byteLength: index + 1,
      sha256: 'c'.repeat(64)
    }
  }))
}

function client(list: QVACModelEntry[]): Pick<QVACRegistryClient, 'findModels'> {
  return {
    findModels: async (query) =>
      list.filter(
        (entry) => entry.path >= (query?.gte?.path ?? '') && entry.path <= (query?.lte?.path ?? '')
      )
  } as Pick<QVACRegistryClient, 'findModels'>
}

function catalogItem(registryPath: string, registrySource = 's3'): RegistryItem {
  return {
    name: 'TEST_COMPONENT',
    registryPath,
    registrySource,
    modelId: registryPath.split('/').pop()!,
    addon: 'diffusion',
    engine: 'sdcpp-generation',
    quantization: '',
    params: '',
    expectedSize: 7,
    sha256Checksum: 'd'.repeat(64),
    blobCoreKey: 'catalog-core',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
}

test('Core ML bundle: a source names a bundle only by its .mlmodelc directory', (t) => {
  t.is(coremlBundleNameOf(`${ROOT}sdxs_unet_fp16.mlmodelc`), 'sdxs_unet_fp16.mlmodelc')
  t.is(coremlBundleNameOf(`${ROOT}sdxs_unet_fp16.mlmodelc/`), 'sdxs_unet_fp16.mlmodelc')
  t.is(coremlBundleNameOf('C:\\models\\unet.mlmodelc\\'), 'unet.mlmodelc')
  t.is(coremlBundleNameOf('unet.mlmodelc'), 'unet.mlmodelc')
  t.absent(coremlBundleNameOf(`${ROOT}sdxs_unet_fp16.mlmodelc/coremldata.bin`))
  t.absent(coremlBundleNameOf(`${ROOT}taesd.safetensors`))
  t.absent(coremlBundleNameOf('/models/.mlmodelc'))
  t.absent(coremlBundleNameOf('/models/unet.mlpackage'))
})

test('Core ML bundle: registry paths name the bundle directory without its trailing slash', (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}sd21base_unet_p6.mlmodelc/`)
  t.alike(bundle, {
    registrySource: 's3',
    bundlePath: `${ROOT}sd21base_unet_p6.mlmodelc`,
    bundleName: 'sd21base_unet_p6.mlmodelc'
  })
  t.is(
    getCoremlBundleSetKey(bundle!),
    getCoremlBundleSetKey(getCoremlBundle('s3', `${ROOT}sd21base_unet_p6.mlmodelc`)!),
    'one set directory for either spelling'
  )
  t.absent(getCoremlBundle('s3', `${ROOT}taesd.safetensors`))
})

test('Core ML bundle: the live registry listing stages every component under the bundle name', async (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}sdxs_unet_fp16.mlmodelc`)!
  const set = await findRegistryCoremlBundleSet(
    client([
      ...entries(bundle.bundlePath),
      // Neighbours whose paths share the prefix without the separator.
      ...entries(`${ROOT}sdxs_unet_fp16.mlmodelc_old`),
      ...entries(`${ROOT}sdxs_tae_decoder.mlmodelc`)
    ]),
    bundle
  )

  t.ok(set)
  t.is(set!.setKey, getCoremlBundleSetKey(bundle))
  t.is(set!.primaryKey, 'coremldata.bin')
  t.alike(
    set!.files.map((file) => file.targetName),
    [...SD_COMPONENTS].sort().map((component) => `sdxs_unet_fp16.mlmodelc/${component}`)
  )
  const root = set!.files.find((file) => file.key === 'coremldata.bin')!
  t.is(root.primary, true)
  t.is(root.registryPath, `${bundle.bundlePath}/coremldata.bin`)
  t.is(root.expectedSize, 2, 'sizes come from the blob binding')
  t.is(root.sha256Checksum, 'c'.repeat(64))
  t.is(root.blobCoreKey, 'bundle-core')
})

test('Core ML bundle: a bundle with other components still stages', async (t) => {
  const bundle = getCoremlBundle(
    's3',
    'qvac_models_compiled/ggml/stable-diffusion/2026-11-23/taesdxl_decoder_768.mlmodelc'
  )!
  const set = await findRegistryCoremlBundleSet(
    client(entries(bundle.bundlePath, CHUNK_COMPONENTS)),
    bundle
  )
  t.is(set?.files.length, CHUNK_COMPONENTS.length)
})

test('Core ML bundle: a listing without the root coremldata.bin is not a bundle', async (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}sdxs_unet_fp16.mlmodelc`)!
  const partial = entries(bundle.bundlePath).filter(
    (entry) => !entry.path.endsWith('/coremldata.bin') || entry.path.includes('analytics')
  )

  t.absent(await findRegistryCoremlBundleSet(client(partial), bundle))
  t.absent(await findRegistryCoremlBundleSet(client([]), bundle))
  t.absent(
    await findRegistryCoremlBundleSet(
      client(entries(bundle.bundlePath, SD_COMPONENTS, 'hf')),
      bundle
    ),
    'another source does not publish this bundle'
  )
})

test('Core ML bundle: components without a checksum or with path tricks are left out', async (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}sdxs_unet_fp16.mlmodelc`)!
  const list = entries(bundle.bundlePath)
  const unbound = { ...list[4]!, blobBinding: undefined } as unknown as QVACModelEntry
  const escaping = { ...list[2]!, path: `${bundle.bundlePath}/../escape.bin` }
  const set = await findRegistryCoremlBundleSet(
    client([...list.slice(0, 2), escaping, list[3]!, unbound]),
    bundle
  )

  t.alike(
    set?.files.map((file) => file.key),
    ['analytics/coremldata.bin', 'coremldata.bin', 'model.mil']
  )
})

test('Core ML bundle: the catalog listing is used once the catalog carries the components', (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}taesd_decoder.mlmodelc`)!
  const catalog = [
    ...SD_COMPONENTS.map((component) => catalogItem(`${bundle.bundlePath}/${component}`)),
    catalogItem(`${ROOT}taesd.safetensors`),
    catalogItem(`${bundle.bundlePath}/coremldata.bin`, 'hf')
  ]

  const set = findCatalogCoremlBundleSet(bundle, catalog)
  t.is(set?.files.length, SD_COMPONENTS.length)
  t.ok(
    set?.files.every(
      (file) => file.registrySource === 's3' && file.sha256Checksum === 'd'.repeat(64)
    )
  )
  t.absent(findCatalogCoremlBundleSet(bundle, []), 'an uncatalogued bundle comes from the registry')
})

test('Core ML bundle: a staged bundle is found again without the registry', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreml-bundle-'))
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
  const bundle = getCoremlBundle('s3', `${ROOT}sd21base_unet_p6.mlmodelc`)!
  const set = await findRegistryCoremlBundleSet(client(entries(bundle.bundlePath)), bundle)

  t.absent(await readCachedCoremlBundleSet(bundle, cacheDir), 'nothing saved yet')
  await writeCachedCoremlBundleSet(set!, cacheDir)
  t.alike(await readCachedCoremlBundleSet(bundle, cacheDir), set)

  const other = getCoremlBundle('s3', `${ROOT}sdxs_unet_fp16.mlmodelc`)!
  t.absent(await readCachedCoremlBundleSet(other, cacheDir), 'another bundle has its own record')

  const tampered = {
    ...set!,
    files: set!.files.map((file) => ({ ...file, targetName: `elsewhere/${file.key}` }))
  }
  await writeCachedCoremlBundleSet(tampered, cacheDir)
  t.absent(
    await readCachedCoremlBundleSet(bundle, cacheDir),
    'a record for another layout is ignored'
  )
})

test('Core ML bundle: the loader returns the bundle directory inside its set', (t) => {
  const bundle = getCoremlBundle('s3', `${ROOT}sdxs_tae_decoder.mlmodelc`)!
  t.is(
    getCoremlBundleDir(bundle, '/cache/models'),
    path.join('/cache/models', 'sets', getCoremlBundleSetKey(bundle), 'sdxs_tae_decoder.mlmodelc')
  )
})
