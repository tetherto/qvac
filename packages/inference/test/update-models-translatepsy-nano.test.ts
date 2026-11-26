import test from 'brittle'
import { createHash } from 'bare-crypto'
import { processRegistryModel } from '@/models/update-models/processing'
import { generateExportName } from '@/models/update-models/naming'
import { groupCompanionSets } from '@/models/update-models/companions'
import { deduplicateModels } from '@/models/update-models/registry'
import { generateModelsFileContent } from '@/models/update-models/codegen'
import type { ProcessedModel } from '@/models/update-models/types'

// Synthetic registry entries in the shape the TranslatePsy Nano registry PR
// publishes: one Hugging Face pack per family/direction/size, each a pair-less
// `model.intgemm.alphas.bin` beside `vocab.spm` and a direction-named lex.
const REPOS = [
  { family: 'AfriNano', sha: '7a793aac03e34b31f53388c22eda26ae108c58e5', vocabPerSize: false },
  { family: 'EuroNano', sha: '3a5e1e4e2f7001ff5cfd79785bef03cf19281b73', vocabPerSize: true }
] as const
const DIRECTIONS = ['en-xx', 'xx-en'] as const
const SIZES = ['Base', 'BaseMemory', 'Tiny'] as const

function hex(seed: string): string {
  return createHash('sha-256').update(seed).digest('hex')
}

function registryEntries() {
  const entries = []
  for (const { family, sha, vocabPerSize } of REPOS) {
    for (const direction of DIRECTIONS) {
      const lex = `lex.50.50.${direction.replace('-', '')}.s2t.bin`
      for (const size of SIZES) {
        const dir = `qvac/TranslatePsy-${family}/resolve/${sha}/${direction}/${size}/intgemm/`
        const files = [
          // Weights differ per size; the AfriNano vocab and both families' lex
          // are byte-identical across the three sizes of a direction.
          { name: 'model.intgemm.alphas.bin', sha256: hex(`${family}${direction}${size}m`) },
          {
            name: 'vocab.spm',
            sha256: hex(`${family}${direction}${vocabPerSize ? size : ''}v`)
          },
          { name: lex, sha256: hex(`${family}${direction}l`) }
        ]
        for (const file of files) {
          entries.push({
            path: `${dir}${file.name}`,
            source: 'hf',
            engine: '@qvac/translation-nmtcpp',
            license: 'Apache-2.0',
            name: '',
            sizeBytes: 1000,
            sha256: file.sha256,
            quantization: '',
            params: '',
            tags: [
              'translation',
              'nmt',
              `translatepsy-${family.toLowerCase()}`,
              direction,
              size === 'BaseMemory' ? 'base-memory' : size.toLowerCase(),
              'bergamot',
              'intgemm'
            ],
            blobBinding: {
              coreKey: Buffer.from('ab'.repeat(32), 'hex'),
              blockOffset: 0,
              blockLength: 1,
              byteOffset: 0,
              byteLength: 1000
            }
          })
        }
      }
    }
  }
  return entries
}

function processed(): ProcessedModel[] {
  return registryEntries().map((entry) => {
    const model = processRegistryModel(entry as never)
    if (!model) throw new Error(`processRegistryModel returned null for ${entry.path}`)
    return model
  })
}

function exportName(model: ProcessedModel, usedNames = new Set<string>()) {
  return generateExportName({
    path: model.registryPath,
    engine: model.engine,
    name: model.modelName,
    quantization: model.quantization,
    params: model.params,
    tags: model.tags,
    usedNames
  })
}

const EXPECTED_CONSTANTS = [
  'TRANSLATEPSY_AFRINANO_EN_XX_BASE',
  'TRANSLATEPSY_AFRINANO_EN_XX_BASE_MEMORY',
  'TRANSLATEPSY_AFRINANO_EN_XX_TINY',
  'TRANSLATEPSY_AFRINANO_XX_EN_BASE',
  'TRANSLATEPSY_AFRINANO_XX_EN_BASE_MEMORY',
  'TRANSLATEPSY_AFRINANO_XX_EN_TINY',
  'TRANSLATEPSY_EURONANO_EN_XX_BASE',
  'TRANSLATEPSY_EURONANO_EN_XX_BASE_MEMORY',
  'TRANSLATEPSY_EURONANO_EN_XX_TINY',
  'TRANSLATEPSY_EURONANO_XX_EN_BASE',
  'TRANSLATEPSY_EURONANO_XX_EN_BASE_MEMORY',
  'TRANSLATEPSY_EURONANO_XX_EN_TINY'
]

test('naming: TranslatePsy Nano packs are named by family, direction and size', (t) => {
  const models = processed()
  t.is(models[0]!.modelName, 'TranslatePsy-AfriNano')
  t.is(models[0]!.addon, 'nmt')

  const usedNames = new Set<string>()
  const names = models.map((model) => exportName(model, usedNames))
  const primaries = names.filter((_, i) => models[i]!.modelId === 'model.intgemm.alphas.bin')
  t.alike(primaries.sort(), [...EXPECTED_CONSTANTS].sort())
  t.ok(names.includes('TRANSLATEPSY_EURONANO_XX_EN_BASE_MEMORY_VOCAB'))
  t.ok(names.includes('TRANSLATEPSY_AFRINANO_EN_XX_TINY_LEX'))
  t.is(new Set(names).size, names.length, 'no collisions, no positional suffixes')
})

test('naming: the Nano rule leaves other NMT and Bergamot names alone', (t) => {
  const name = generateExportName({
    path: 'qvac_models_compiled/bergamot/bergamot-ende/2025-12-18/model.ende.intgemm.alphas.bin',
    engine: 'nmtcpp-translation',
    name: 'bergamot',
    quantization: '',
    params: '',
    tags: ['translation', 'nmt', 'bergamot', 'ende'],
    usedNames: new Set()
  })
  t.is(name, 'BERGAMOT_EN_DE')
  const fp32 = generateExportName({
    path: 'qvac/TranslatePsy-AfriNano/resolve/abc/en-xx/Base/fp32/vocab.spm',
    engine: 'nmtcpp-translation',
    name: 'TranslatePsy-AfriNano',
    quantization: '',
    params: '',
    tags: [],
    usedNames: new Set()
  })
  t.is(fp32, 'NMT_TRANSLATEPSY_AFRINANO', 'only the intgemm layout is a Nano pack')
})

test('companions: each Nano pack claims the vocab and lex in its own directory', (t) => {
  const grouped = groupCompanionSets(processed())
  const primaries = grouped.filter((m) => m.modelId === 'model.intgemm.alphas.bin')
  t.is(primaries.length, 12)

  for (const primary of primaries) {
    const dir = primary.registryPath.slice(0, primary.registryPath.lastIndexOf('/') + 1)
    const set = primary.companionSet
    t.ok(set, `${primary.registryPath} has a companion set`)
    t.absent(primary.isCompanionOnly)
    t.alike(
      set!.files.map((f) => [f.key, f.registryPath, f.targetName]),
      [
        ['modelPath', primary.registryPath, 'model.intgemm.alphas.bin'],
        [
          'lexPath',
          `${dir}${dir.includes('/en-xx/') ? 'lex.50.50.enxx.s2t.bin' : 'lex.50.50.xxen.s2t.bin'}`,
          dir.includes('/en-xx/') ? 'lex.50.50.enxx.s2t.bin' : 'lex.50.50.xxen.s2t.bin'
        ],
        ['sharedVocabPath', `${dir}vocab.spm`, 'vocab.spm']
      ]
    )
  }

  const companions = grouped.filter((m) => m.modelId !== 'model.intgemm.alphas.bin')
  t.is(companions.length, 24)
  t.ok(
    companions.every((m) => m.isCompanionOnly),
    'vocab and lex are companions, not exported models'
  )
  t.is(new Set(primaries.map((m) => m.companionSet!.setKey)).size, 12, 'one cache set per pack')
})

test('dedup: byte-identical vocab and lex survive for every pack size', (t) => {
  const deduped = deduplicateModels(groupCompanionSets(processed()), false)
  t.is(deduped.length, 36, 'no file is dropped as a checksum duplicate')

  const paths = new Set(deduped.map((m) => `${m.registrySource}:${m.registryPath}`))
  for (const primary of deduped.filter((m) => m.companionSet)) {
    for (const file of primary.companionSet!.files) {
      t.ok(paths.has(`${file.registrySource}:${file.registryPath}`), `${file.registryPath} kept`)
    }
  }
})

test('codegen: the catalog exports exactly the twelve pack constants', (t) => {
  const content = generateModelsFileContent(
    deduplicateModels(groupCompanionSets(processed()), false)
  )
  const exported = [...content.matchAll(/^export const (TRANSLATEPSY_\w+) = \{/gm)].map((m) => m[1])
  t.alike(exported.sort(), [...EXPECTED_CONSTANTS].sort())
})
