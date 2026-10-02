// Runs impacted-tests.mjs against a fixture repository.
// esbuild comes from this package's node_modules, or from ESBUILD_MODULE.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAPPER = path.resolve(HERE, '..', 'impacted-tests.mjs')
const REPORT_ACTION = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  '..',
  '.github',
  'actions',
  'sdk-e2e-report-impacted',
  'action.yml'
)
const ESBUILD = process.env['ESBUILD_MODULE'] ?? createRequire(import.meta.url).resolve('esbuild')

const CONSUMER = 'packages/sdk/e2e/tests/desktop/consumer.ts'
const INFERENCE_MANIFEST = 'packages/inference/package.json'
const SDK_MANIFEST = 'packages/sdk/package.json'
const SCHEMAS = 'packages/inference/src/schemas'
const SDCPP_SCHEMA = `${SCHEMAS}/sdcpp-config.ts`
const BUILTIN = 'packages/inference/src/plugins/builtin'

const FILES = {
  'packages/sdk/e2e/tests/test-definitions.ts': `export const tests = [
  { testId: 'tts-basic', suites: ['smoke'], metadata: { dependency: 'tts' } },
  { testId: 'tts-long', metadata: { dependency: 'tts', estimatedDurationMs: 60000 } },
  { testId: 'diffusion-upscale', metadata: { dependency: 'diffusion-esrgan' } },
  { testId: 'whisper-basic', metadata: { dependency: 'whisper' } },
  { testId: 'odd-resource', metadata: { dependency: 'bad id' } },
  { testId: 'llm-basic', metadata: { dependency: 'llm' } }
]
`,
  [CONSUMER]: `import { resources } from '@qvac/test-suite'

resources.define('tts', {
  constant: TTS_MODEL,
  type: 'tts-ggml'
})

resources.define('diffusion-esrgan', {
  constant: SD_MODEL,
  type: 'sdcpp-generation',
  config: {
    params_backend: 'vae=cpu'
  }
})

resources.define('unused', {
  type: 'llamacpp-completion'
})

resources.define('whisper', {
  type: 'whispercpp-transcription'
})

resources.define('bad id', {
  type: 'llamacpp-completion'
})
`,
  [INFERENCE_MANIFEST]: JSON.stringify(
    {
      name: '@qvac/inference',
      dependencies: { '@qvac/logging': '^0.1.1' },
      peerDependencies: {
        '@qvac/asr-ggml': '^0.5.3',
        '@qvac/decoder-audio': '^0.7.0',
        '@qvac/diffusion-cpp': '^0.25.0',
        '@qvac/ocr-ggml': '^0.24.1',
        '@qvac/tts-ggml': '^0.9.1',
        '@qvac/tts-voices': '^0.1.0'
      }
    },
    null,
    2
  ),
  'packages/inference/src/registry.ts': `import { handleUnload } from '@/handlers/unload-model'

export const registry = {
  unloadModel: { type: 'reply', handler: handleUnload }
}
`,
  // A default, a bare, a barrel and a by-path import.
  [`${BUILTIN}/tts-ggml/plugin.ts`]: `import TTSGgml from '@qvac/tts-ggml'
import '@qvac/tts-voices'
import { ttsRequestSchema, MODEL_TYPES } from '@/schemas/index'
import { Voice } from '@/schemas/text-to-speech'
`,
  [`${BUILTIN}/sdcpp-generation/plugin.ts`]: `import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
`,
  // The addon reaches this engine only through a dynamic import.
  [`${BUILTIN}/sdcpp-generation/ops/upscale.ts`]: `export const load = () => import('@qvac/diffusion-cpp/addonLogging')
`,
  [`${BUILTIN}/sdcpp-generation/ops/video.ts`]: `import * as video from '@/schemas/video-config'
`,
  // An engine no test loads.
  [`${BUILTIN}/ggml-ocr/plugin.ts`]: `import OCR from '@qvac/ocr-ggml'
import { hyperdriveUrlSchema } from '@/schemas/load-model'
`,
  // A helper directory: no plugin, imported by two engines, one of them tested.
  [`${BUILTIN}/asr-helper/config.ts`]: `import ASR from '@qvac/asr-ggml'
import { whisperConfigSchema } from '../../../schemas/transcription-config'

export const asrConfig = whisperConfigSchema
`,
  // An import right after a braced declaration is a clause of its own.
  [`${BUILTIN}/whispercpp-transcription/plugin.ts`]: `import { asrConfig } from '@/plugins/builtin/asr-helper/config'

export interface Options {
  mode: string
}
import { vadSchema } from '@/schemas/vad'
`,
  [`${BUILTIN}/parakeet-transcription/plugin.ts`]: `import { asrConfig } from '../asr-helper/config'
`,
  [SDCPP_SCHEMA]: `// Diffusion model config.

import { z } from 'zod'

const cacheMode = z.enum(['a', 'b'])

export const sdcppConfigSchema = z.object({
  cache: cacheMode.optional(),
  vae: z.string().optional()
})

/** Only the SDK reads this. */
export type SdcppInternal = { a: string }
`,
  [`${SCHEMAS}/text-to-speech.ts`]: `import { z } from 'zod'

export const ttsRequestSchema = z.object({ text: z.string() })

export const enum Voice {
  A = 'a'
}
`,
  [`${SCHEMAS}/load-model.ts`]: `import { z } from 'zod'

export const hyperdriveUrlSchema = z.string()
`,
  [`${SCHEMAS}/models.ts`]: `export const PUBLIC_TYPES = ['tts']
`,
  [`${SCHEMAS}/video-config.ts`]: `export const fps = 24
`,
  [`${SCHEMAS}/common.ts`]: `import { z } from 'zod'

export const baseSchema = z.object({ id: z.string() })
`,
  [`${SCHEMAS}/transcription-config.ts`]: `import {
  baseSchema, // shared (see #12
  type $Legacy
} from './common'

export const whisperConfigSchema = baseSchema.extend({})
`,
  [`${SCHEMAS}/vad.ts`]: `export const vadSchema = 1
`,
  [`${SCHEMAS}/index.ts`]: `export * from './sdcpp-config'
export * from './text-to-speech'
export * from './load-model'
export { PUBLIC_TYPES as MODEL_TYPES } from './models'
`
}

function makeRepo() {
  // The mapper compares its own resolved location against the root.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'impacted-tests-')))
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  const mapper = path.join(root, 'packages/sdk/e2e/scripts/impacted-tests.mjs')
  mkdirSync(path.dirname(mapper), { recursive: true })
  copyFileSync(MAPPER, mapper)
  return { root, mapper }
}

const repo = makeRepo()
after(() => rmSync(repo.root, { recursive: true, force: true }))

function analyze(files) {
  const prFiles = path.join(repo.root, 'pr-files.json')
  const report = path.join(repo.root, 'report.json')
  writeFileSync(prFiles, JSON.stringify(files))
  execFileSync(
    process.execPath,
    [repo.mapper, '--repo-root', repo.root, '--pr-files', prFiles, '--json', report],
    { env: { ...process.env, ESBUILD_MODULE: ESBUILD }, stdio: 'pipe' }
  )
  return JSON.parse(readFileSync(report, 'utf8'))
}

function lineOf(file, snippet) {
  const index = FILES[file].split('\n').findIndex((line) => line.includes(snippet))
  assert.ok(index >= 0, `${snippet} not in ${file}`)
  return index + 1
}

// A one-line edit, as `git diff -U0` prints it.
function editLine(file, snippet) {
  const line = lineOf(file, snippet)
  const text = FILES[file].split('\n')[line - 1]
  return `@@ -${line},1 +${line},1 @@\n-${text} // before\n+${text}`
}

function bump(name) {
  const line = lineOf(INFERENCE_MANIFEST, `"${name}"`)
  const text = FILES[INFERENCE_MANIFEST].split('\n')[line - 1]
  return `@@ -${line},1 +${line},1 @@\n-${text.replace(/"\^[^"]*"/, '"^0.0.1"')}\n+${text}`
}

const rows = (report, via) => report.attribution.filter((entry) => entry.via === via)

test('an addon bump reaches the tests of the engine importing it', () => {
  const report = analyze([{ filename: INFERENCE_MANIFEST, patch: bump('@qvac/tts-ggml') }])
  assert.deepEqual(rows(report, 'addon dependency'), [
    { file: '@qvac/tts-ggml', via: 'addon dependency', tests: 2 }
  ])
  assert.equal(report.changedFilesInScope, 1)
  assert.deepEqual(report.includeTests, ['tts-long'])
  assert.deepEqual(report.unmapped, [])
})

test('the same bump in both manifests yields one row', () => {
  const report = analyze([
    { filename: INFERENCE_MANIFEST, patch: bump('@qvac/tts-ggml') },
    { filename: SDK_MANIFEST, patch: bump('@qvac/tts-ggml') }
  ])
  assert.equal(report.changedFilesInScope, 2)
  assert.equal(rows(report, 'addon dependency').length, 1)
})

test('dynamic and bare imports link an addon too', () => {
  assert.deepEqual(
    analyze([{ filename: INFERENCE_MANIFEST, patch: bump('@qvac/diffusion-cpp') }]).affected,
    ['diffusion-upscale']
  )
  assert.deepEqual(
    analyze([{ filename: INFERENCE_MANIFEST, patch: bump('@qvac/tts-voices') }]).affected,
    ['tts-basic', 'tts-long']
  )
})

test('a swapped addon counts both the removed and the added one', () => {
  const line = lineOf(INFERENCE_MANIFEST, '"@qvac/tts-ggml"')
  const patch = `@@ -${line},1 +${line},1 @@\n-    "@qvac/tts-ggml": "^0.9.1",\n+    "@qvac/ocr-ggml": "^0.24.1",`
  const report = analyze([{ filename: INFERENCE_MANIFEST, patch }])
  assert.deepEqual(report.affected, ['tts-basic', 'tts-long'])
  assert.deepEqual(report.unmapped, ['@qvac/ocr-ggml'])
})

test('an addon reaches the engines using it through a helper directory', () => {
  const report = analyze([{ filename: INFERENCE_MANIFEST, patch: bump('@qvac/asr-ggml') }])
  assert.deepEqual(report.affected, ['whisper-basic'])
  // The engine sharing the helper has no test; it is listed, not dropped.
  assert.deepEqual(report.unmapped, [`${BUILTIN}/parakeet-transcription`])
})

test('a non-addon dependency or a version change leaves the manifest out of scope', () => {
  const patch = `${bump('@qvac/logging')}\n@@ -2,1 +2,1 @@\n-  "version": "0.1.0",\n+  "name": "@qvac/inference",`
  const report = analyze([{ filename: INFERENCE_MANIFEST, patch }])
  assert.equal(report.changedFilesInScope, 0)
  assert.deepEqual(report.attribution, [])
  assert.deepEqual(report.unmapped, [])
})

test('an addon no plugin imports, or whose engines no test loads, is unmapped', () => {
  const report = analyze([
    {
      filename: INFERENCE_MANIFEST,
      patch: `${bump('@qvac/decoder-audio')}\n${bump('@qvac/ocr-ggml')}`
    }
  ])
  assert.deepEqual(report.affected, [])
  assert.deepEqual(report.unmapped.sort(), ['@qvac/decoder-audio', '@qvac/ocr-ggml'])
})

test('a manifest without a patch is listed, not dropped', () => {
  const report = analyze([{ filename: SDK_MANIFEST }])
  assert.equal(report.changedFilesInScope, 1)
  assert.deepEqual(report.unmapped, [SDK_MANIFEST])
})

test('a changed manifest is listed when the inference manifest is missing', () => {
  const manifest = path.join(repo.root, INFERENCE_MANIFEST)
  renameSync(manifest, `${manifest}.away`)
  try {
    const report = analyze([{ filename: SDK_MANIFEST, patch: bump('@qvac/tts-ggml') }])
    assert.deepEqual(report.affected, [])
    assert.deepEqual(report.unmapped, [SDK_MANIFEST])
  } finally {
    renameSync(`${manifest}.away`, manifest)
  }
})

test('a change inside a resource definition reaches the tests depending on it', () => {
  const report = analyze([{ filename: CONSUMER, patch: editLine(CONSUMER, 'params_backend') }])
  assert.deepEqual(report.attribution, [
    { file: `${CONSUMER}#diffusion-esrgan`, via: 'resource definition', tests: 1 }
  ])
  assert.deepEqual(report.unmapped, [])
})

test('a removal without context is located in the file as it was', () => {
  const line = lineOf(CONSUMER, 'params_backend')
  const report = analyze([
    { filename: CONSUMER, patch: `@@ -${line},1 +${line - 1},0 @@\n-    vae_on_cpu: true,` }
  ])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
})

test('a removed definition is named from the file as it was', () => {
  // `gone` sat right after `unused`, whose closing line is the context.
  const line = lineOf(CONSUMER, "define('whisper'")
  const patch = [
    `@@ -${line - 2},5 +${line - 2},1 @@`,
    ' })',
    '-',
    "-resources.define('gone', {",
    "-  type: 'tts-ggml'",
    '-})'
  ].join('\n')
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.affected, [])
  assert.deepEqual(report.unmapped, [`${CONSUMER}#gone`])
})

test('a patch with context attributes only its changed lines', () => {
  const line = lineOf(CONSUMER, 'params_backend')
  const patch = [
    `@@ -${line - 3},7 +${line - 3},7 @@ resources.define('diffusion-esrgan', {`,
    '   constant: SD_MODEL,',
    "   type: 'sdcpp-generation',",
    '   config: {',
    '-    vae_on_cpu: true',
    "+    params_backend: 'vae=cpu'",
    '   }',
    ' })',
    '',
    // A blank line between two definitions changes nothing.
    `@@ -${line + 6},0 +${line + 7},1 @@`,
    '+'
  ].join('\n')
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
  assert.deepEqual(report.unmapped, [])
})

test("git's file header and the no-newline marker are not read as changes", () => {
  const header = `diff --git a/${CONSUMER} b/${CONSUMER}\nindex 1111111..2222222 100644\n--- a/${CONSUMER}\n+++ b/${CONSUMER}`
  const patch = `${header}\n${editLine(CONSUMER, 'params_backend')}\n\\ No newline at end of file`
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
  assert.deepEqual(report.unmapped, [])
})

test('a consumer change outside every definition stays unmapped', () => {
  const patch = `${editLine(CONSUMER, 'import')}\n${editLine(CONSUMER, 'params_backend')}`
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
  assert.deepEqual(report.unmapped, [CONSUMER])
})

test('a resource no test depends on is unmapped by name', () => {
  const line = lineOf(CONSUMER, "define('unused'") + 1
  const patch = `@@ -${line},1 +${line},1 @@\n-  type: 'llm'\n+  type: 'llamacpp-completion'`
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.affected, [])
  assert.deepEqual(report.unmapped, [`${CONSUMER}#unused`])
})

test('a resource id unsafe to echo falls back to the file path', () => {
  const line = lineOf(CONSUMER, "define('bad id'") + 1
  const patch = `@@ -${line},1 +${line},1 @@\n-  type: 'llm'\n+  type: 'llamacpp-completion'`
  const report = analyze([{ filename: CONSUMER, patch }])
  assert.deepEqual(report.attribution, [{ file: CONSUMER, via: 'resource definition', tests: 1 }])
})

test('a consumer without a patch stays unmapped', () => {
  const report = analyze([{ filename: CONSUMER }])
  assert.deepEqual(report.attribution, [])
  assert.deepEqual(report.unmapped, [CONSUMER])
})

test('a schema change reaches the engine importing its declaration by path', () => {
  const report = analyze([{ filename: SDCPP_SCHEMA, patch: editLine(SDCPP_SCHEMA, 'vae:') }])
  assert.deepEqual(report.attribution, [{ file: SDCPP_SCHEMA, via: 'inference schema', tests: 1 }])
  assert.deepEqual(report.unmapped, [])
})

test('an unexported declaration reaches the export that uses it', () => {
  const report = analyze([{ filename: SDCPP_SCHEMA, patch: editLine(SDCPP_SCHEMA, 'cacheMode =') }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
})

test('an import reaches the declarations using what it binds', () => {
  const report = analyze([{ filename: SDCPP_SCHEMA, patch: editLine(SDCPP_SCHEMA, "from 'zod'") }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
  assert.deepEqual(report.unmapped, [])
})

test('a schema reaches its engine through the barrel, also under an alias', () => {
  const tts = `${SCHEMAS}/text-to-speech.ts`
  const models = `${SCHEMAS}/models.ts`
  for (const [file, snippet] of [
    [tts, 'ttsRequestSchema'],
    [models, 'PUBLIC_TYPES']
  ]) {
    const report = analyze([{ filename: file, patch: editLine(file, snippet) }])
    assert.deepEqual(report.affected, ['tts-basic', 'tts-long'], file)
  }
})

test('a const enum is a declaration like any other', () => {
  const file = `${SCHEMAS}/text-to-speech.ts`
  const report = analyze([{ filename: file, patch: editLine(file, "A = 'a'") }])
  assert.deepEqual(report.affected, ['tts-basic', 'tts-long'])
})

test('a namespace import takes every export of the schema', () => {
  const file = `${SCHEMAS}/video-config.ts`
  const report = analyze([{ filename: file, patch: editLine(file, 'fps') }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
})

test('a schema reaches engines through other schemas, relative imports and helpers', () => {
  for (const file of [`${SCHEMAS}/common.ts`, `${SCHEMAS}/transcription-config.ts`]) {
    const snippet = file.endsWith('common.ts') ? 'baseSchema =' : 'whisperConfigSchema ='
    const report = analyze([{ filename: file, patch: editLine(file, snippet) }])
    assert.deepEqual(report.affected, ['whisper-basic'], file)
    assert.deepEqual(report.unmapped, [`${BUILTIN}/parakeet-transcription`], file)
  }
})

test('a schema change no plugin import reaches is unmapped', () => {
  // The file header, and a comment above a declaration only the SDK reads.
  for (const snippet of ['Diffusion model config', 'Only the SDK']) {
    const report = analyze([{ filename: SDCPP_SCHEMA, patch: editLine(SDCPP_SCHEMA, snippet) }])
    assert.deepEqual(report.affected, [], snippet)
    assert.deepEqual(report.unmapped, [SDCPP_SCHEMA], snippet)
  }
})

test('a removed line is located in the schema as it was', () => {
  // `extra` was the tail of `sdcppConfigSchema`; the added doc comment belongs
  // to `SdcppInternal`, which no plugin reads.
  const line = lineOf(SDCPP_SCHEMA, 'vae:')
  const patch = [
    `@@ -${line},6 +${line},5 @@`,
    '   vae: z.string().optional()',
    '-  extra: z.number()',
    ' })',
    ' ',
    '-/** Old note. */',
    '+/** Only the SDK reads this. */',
    ' export type SdcppInternal = { a: string }'
  ].join('\n')
  const report = analyze([{ filename: SDCPP_SCHEMA, patch }])
  assert.deepEqual(report.affected, ['diffusion-upscale'])
  assert.deepEqual(report.unmapped, [SDCPP_SCHEMA])
})

test('a star re-export, a schema only an untested engine imports, and one without a patch are unmapped', () => {
  const index = `${SCHEMAS}/index.ts`
  const loadModel = `${SCHEMAS}/load-model.ts`
  const report = analyze([
    { filename: index, patch: editLine(index, "'./sdcpp-config'") },
    { filename: loadModel, patch: editLine(loadModel, 'hyperdriveUrlSchema') },
    { filename: `${SCHEMAS}/common.ts` }
  ])
  assert.deepEqual(report.affected, [])
  assert.deepEqual(report.unmapped.sort(), [`${SCHEMAS}/common.ts`, index, loadModel])
})

test('an import after a braced declaration still links', () => {
  const vad = `${SCHEMAS}/vad.ts`
  assert.deepEqual(analyze([{ filename: vad, patch: editLine(vad, 'vadSchema') }]).affected, [
    'whisper-basic'
  ])
})

test('a schema import list with a comment and a `$` name resolves without failing', () => {
  const file = `${SCHEMAS}/transcription-config.ts`
  const report = analyze([{ filename: file, patch: editLine(file, 'type $Legacy') }])
  assert.deepEqual(report.affected, ['whisper-basic'])
})

test('the engine relation is unchanged', () => {
  const file = `${BUILTIN}/tts-ggml/plugin.ts`
  const report = analyze([{ filename: file, patch: editLine(file, "from '@qvac/tts-ggml'") }])
  assert.deepEqual(report.attribution, [
    { file: `${BUILTIN}/tts-ggml`, via: 'inference engine', tests: 2 }
  ])
})

test("every row and unmapped entry passes the report action's filters", () => {
  const action = readFileSync(REPORT_ACTION, 'utf8')
  const knownVia = new Set(
    [.../KNOWN_VIA = new Set\(\[([\s\S]*?)\]\)/.exec(action)[1].matchAll(/'([^']+)'/g)].map(
      (match) => match[1]
    )
  )
  const safePath = new RegExp(/const SAFE_PATH = \/(.+)\/;/.exec(action)[1])
  const report = analyze([
    { filename: INFERENCE_MANIFEST, patch: `${bump('@qvac/tts-ggml')}\n${bump('@qvac/ocr-ggml')}` },
    {
      filename: CONSUMER,
      patch: `${editLine(CONSUMER, 'params_backend')}\n${editLine(CONSUMER, 'import')}`
    },
    { filename: SDCPP_SCHEMA, patch: editLine(SDCPP_SCHEMA, 'vae:') },
    { filename: `${SCHEMAS}/common.ts`, patch: editLine(`${SCHEMAS}/common.ts`, 'baseSchema =') },
    {
      filename: `${BUILTIN}/ggml-ocr/plugin.ts`,
      patch: editLine(`${BUILTIN}/ggml-ocr/plugin.ts`, 'OCR')
    }
  ])
  assert.deepEqual([...new Set(report.attribution.map((entry) => entry.via))].sort(), [
    'addon dependency',
    'inference schema',
    'resource definition'
  ])
  for (const entry of report.attribution) {
    assert.ok(knownVia.has(entry.via), entry.via)
    assert.match(entry.file, safePath)
  }
  assert.ok(report.unmapped.length >= 4)
  for (const entry of report.unmapped) assert.match(entry, safePath)
})
