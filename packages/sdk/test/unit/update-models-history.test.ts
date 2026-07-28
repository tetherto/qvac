import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'brittle'
import { generateModelsFileContent } from '@/models/update-models/codegen'
import { extractEntryBlocks, loadCurrentModels } from '@/models/update-models/history'
import type { ProcessedModel } from '@/models/update-models/types'

function makeModel(overrides: Partial<ProcessedModel> & { registryPath: string }): ProcessedModel {
  return {
    registrySource: 's3',
    modelId: overrides.registryPath.split('/').pop() || '',
    addon: 'llm',
    engine: 'llamacpp-completion',
    modelName: 'qwen3',
    quantization: 'q4_0',
    params: '4B',
    tags: ['generation'],
    expectedSize: 1000,
    sha256Checksum: 'sha',
    blobCoreKey: 'key',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    ...overrides
  }
}

function withTempFile(contents: string, fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-history-'))
  const file = path.join(dir, 'models.ts')
  try {
    fs.writeFileSync(file, contents)
    fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('loadCurrentModels: round-trips the generated file', (t) => {
  const content = generateModelsFileContent([
    makeModel({ registryPath: 'org/repo/qwen3-4b-q4_0.gguf' }),
    makeModel({ registryPath: 'org/repo/qwen3-8b-q8_0.gguf', params: '8B', quantization: 'q8_0' })
  ])

  withTempFile(content, (file) => {
    const loaded = loadCurrentModels(file)

    t.is(loaded.length, 2, 'reads every entry back')
    t.is(loaded[0]!.registryPath, 'org/repo/qwen3-4b-q4_0.gguf', 'keeps the first path')
    t.is(loaded[1]!.registryPath, 'org/repo/qwen3-8b-q8_0.gguf', 'keeps the second path')
    t.ok(
      loaded.every((m) => m.name.length > 0),
      'every entry carries a name'
    )
  })
})

// ---------------------------------------------------------------------------
// Regression: codegen emits double quotes, then `update-models` runs Prettier
// over the file, which rewrites them to single quotes. A reader that only
// matched double quotes parsed 0 models at rest, so every remote model looked
// new and removals were reported as none at all.
// ---------------------------------------------------------------------------

test('loadCurrentModels: reads Prettier-normalised single quotes', (t) => {
  const content = `export const models = [
  {
    name: 'QWEN3_4B_Q4_0',
    registryPath: 'org/repo/qwen3-4b-q4_0.gguf',
    registrySource: 's3',
    quantization: 'q4_0'
  }
] as const satisfies readonly RegistryItem[];
`

  withTempFile(content, (file) => {
    const loaded = loadCurrentModels(file)

    t.is(loaded.length, 1, 'parses the entry')
    t.is(loaded[0]!.name, 'QWEN3_4B_Q4_0', 'reads the name')
    t.is(loaded[0]!.registryPath, 'org/repo/qwen3-4b-q4_0.gguf', 'reads the registry path')
  })
})

test('loadCurrentModels: reads values Prettier wrapped onto the next line', (t) => {
  const content = `export const models = [
  {
    name: 'MMPROJ_UNLIMITED_OCR_F16',
    registryPath:
      'someuser/unlimited-ocr-gguf/resolve/45cd66ec6b46a7c4de49f376084ecec2b8d3c59a/mmproj-unlimited-ocr-F16.gguf',
    registrySource: 'hf'
  }
] as const satisfies readonly RegistryItem[];
`

  withTempFile(content, (file) => {
    const loaded = loadCurrentModels(file)

    t.is(loaded.length, 1, 'parses the wrapped entry')
    t.is(
      loaded[0]!.registryPath,
      'someuser/unlimited-ocr-gguf/resolve/45cd66ec6b46a7c4de49f376084ecec2b8d3c59a/mmproj-unlimited-ocr-F16.gguf',
      'reads the wrapped registry path'
    )
  })
})

// ---------------------------------------------------------------------------
// Regression: entries carrying `companionSet` / `shardMetadata` contain nested
// objects. A `[^}]+`-bounded regex could not span them, so those entries were
// skipped and their companion files could be mistaken for models of their own.
// ---------------------------------------------------------------------------

test('loadCurrentModels: handles entries with nested companion sets', (t) => {
  const companionSet = {
    setKey: 'bergamot-fren',
    primaryKey: 'model',
    files: [
      {
        key: 'model',
        registryPath: 'bergamot-fren/model.fren.bin',
        registrySource: 's3',
        targetName: 'model.bin',
        expectedSize: 10,
        sha256Checksum: 'a',
        blobCoreKey: 'k',
        blobBlockOffset: 0,
        blobBlockLength: 1,
        blobByteOffset: 0,
        primary: true
      },
      {
        key: 'vocab',
        registryPath: 'bergamot-fren/vocab.fren.spm',
        registrySource: 's3',
        targetName: 'vocab.spm',
        expectedSize: 20,
        sha256Checksum: 'b',
        blobCoreKey: 'k',
        blobBlockOffset: 0,
        blobBlockLength: 1,
        blobByteOffset: 0
      }
    ]
  }

  const content = generateModelsFileContent([
    makeModel({
      registryPath: 'bergamot-fren/model.fren.bin',
      addon: 'nmt',
      engine: 'nmtcpp-translation',
      companionSet
    }),
    makeModel({ registryPath: 'org/repo/qwen3-4b-q4_0.gguf' })
  ])

  withTempFile(content, (file) => {
    const loaded = loadCurrentModels(file)

    t.is(loaded.length, 2, 'the nested object does not swallow the following entry')
    t.is(
      loaded[0]!.registryPath,
      'bergamot-fren/model.fren.bin',
      'takes the top-level path, not a companion file path'
    )
    t.absent(
      loaded.some((m) => m.registryPath === 'bergamot-fren/vocab.fren.spm'),
      'companion files are not reported as models'
    )
  })
})

test('extractEntryBlocks: ignores braces inside string literals', (t) => {
  const blocks = extractEntryBlocks(`
  {
    name: 'A',
    notes: 'a } brace and a { brace'
  },
  {
    name: 'B'
  }
`)

  t.is(blocks.length, 2, 'splits into two entries')
  t.ok(blocks[0]!.includes("name: 'A'"), 'first block is the first entry')
  t.ok(blocks[1]!.includes("name: 'B'"), 'second block is the second entry')
})

test('loadCurrentModels: returns empty for a missing file', (t) => {
  t.is(loadCurrentModels(path.join(os.tmpdir(), 'qvac-does-not-exist', 'models.ts')).length, 0)
})
