import assert from 'node:assert/strict'
import test from 'node:test'

import { generateModelsFileContent } from '../models/update-models/codegen.ts'
import { groupCompanionSets } from '../models/update-models/companions.ts'
import { generateExportName } from '../models/update-models/naming.ts'
import { deduplicateModels } from '../models/update-models/registry.ts'
import type { ProcessedModel } from '../models/update-models/types.ts'

// Mirrors packages/inference/test/update-models-translatepsy-nano.test.ts: one
// Hugging Face pack per family/direction/size, pair-less filenames, and the
// vocab/lex checksums the registry publishes (AfriNano vocab and both
// families' lex are byte-identical across the three sizes of a direction).
const REPOS = [
  { family: 'AfriNano', sha: '7a793aac03e34b31f53388c22eda26ae108c58e5', vocabPerSize: false },
  { family: 'EuroNano', sha: '3a5e1e4e2f7001ff5cfd79785bef03cf19281b73', vocabPerSize: true }
] as const
const DIRECTIONS = ['en-xx', 'xx-en'] as const
const SIZES = ['Base', 'BaseMemory', 'Tiny'] as const

function packs(): ProcessedModel[] {
  const models: ProcessedModel[] = []
  for (const { family, sha, vocabPerSize } of REPOS) {
    for (const direction of DIRECTIONS) {
      const lex = `lex.50.50.${direction.replace('-', '')}.s2t.bin`
      for (const size of SIZES) {
        const dir = `qvac/TranslatePsy-${family}/resolve/${sha}/${direction}/${size}/intgemm/`
        const files = [
          { name: 'model.intgemm.alphas.bin', sha256: `${family}-${direction}-${size}-model` },
          { name: 'vocab.spm', sha256: `${family}-${direction}-${vocabPerSize ? size : ''}-vocab` },
          { name: lex, sha256: `${family}-${direction}-lex` }
        ]
        for (const file of files) {
          models.push({
            registryPath: `${dir}${file.name}`,
            registrySource: 'hf',
            modelId: file.name,
            addon: 'nmt',
            engine: 'nmtcpp-translation',
            modelName: `TranslatePsy-${family}`,
            quantization: '',
            params: '',
            tags: ['translation', 'nmt', `translatepsy-${family.toLowerCase()}`, direction],
            expectedSize: 1000,
            sha256Checksum: file.sha256,
            blobCoreKey: 'core',
            blobBlockOffset: 0,
            blobBlockLength: 1,
            blobByteOffset: 0
          })
        }
      }
    }
  }
  return models
}

const EXPECTED_CONSTANTS = REPOS.flatMap(({ family }) =>
  DIRECTIONS.flatMap((direction) =>
    ['BASE', 'BASE_MEMORY', 'TINY'].map(
      (size) =>
        `TRANSLATEPSY_${family.toUpperCase()}_${direction === 'en-xx' ? 'EN_XX' : 'XX_EN'}_${size}`
    )
  )
).sort()

test('TranslatePsy Nano packs are named by family, direction and size', () => {
  const usedNames = new Set<string>()
  const names = packs().map((model) =>
    generateExportName({
      path: model.registryPath,
      engine: model.engine,
      name: model.modelName,
      quantization: model.quantization,
      params: model.params,
      tags: model.tags,
      usedNames
    })
  )
  assert.deepEqual(names.filter((name) => !/_(VOCAB|LEX)$/.test(name)).sort(), EXPECTED_CONSTANTS)
  assert.ok(names.includes('TRANSLATEPSY_AFRINANO_XX_EN_BASE_MEMORY_VOCAB'))
  assert.ok(names.includes('TRANSLATEPSY_EURONANO_EN_XX_TINY_LEX'))
  assert.equal(new Set(names).size, names.length)
})

test('each Nano pack groups the vocab and lex in its own directory and keeps them through dedup', () => {
  const deduped = deduplicateModels(groupCompanionSets(packs()), false)
  assert.equal(deduped.length, 36, 'no vocab or lex is dropped as a checksum duplicate')

  const primaries = deduped.filter((m) => m.modelId === 'model.intgemm.alphas.bin')
  assert.equal(primaries.length, 12)
  for (const primary of primaries) {
    const dir = primary.registryPath.slice(0, primary.registryPath.lastIndexOf('/') + 1)
    const lex = dir.includes('/en-xx/') ? 'lex.50.50.enxx.s2t.bin' : 'lex.50.50.xxen.s2t.bin'
    assert.deepEqual(
      primary.companionSet?.files.map((f) => [f.key, f.registryPath]),
      [
        ['modelPath', primary.registryPath],
        ['lexPath', `${dir}${lex}`],
        ['sharedVocabPath', `${dir}vocab.spm`]
      ]
    )
  }
  assert.ok(deduped.filter((m) => !primaries.includes(m)).every((m) => m.isCompanionOnly))

  const content = generateModelsFileContent(deduped)
  const exported = [...content.matchAll(/^export const (TRANSLATEPSY_\w+): ModelConstant</gm)].map(
    (m) => m[1]
  )
  assert.deepEqual(exported.sort(), EXPECTED_CONSTANTS)
})
