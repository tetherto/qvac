'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createModelSchema } = require('../../scripts/validate-models-json')
const {
  engineToAddon,
  legacyEngineToCanonical,
  legacyRegistryEngineRules
} = require('../../lib/generated/engine-manifest.json')

const schema = createModelSchema(new Set(['MIT']))
const model = {
  source: 'https://huggingface.co/example/models/resolve/' + 'a'.repeat(40) + '/model.gguf',
  licenseId: 'MIT'
}

test('submissions accept every supported canonical engine and legacy identifier', (t) => {
  for (const engine of [...Object.keys(engineToAddon), ...Object.keys(legacyEngineToCanonical)]) {
    t.ok(schema.safeParse({ ...model, engine }).success, engine)
  }
  for (const [engine, rules] of Object.entries(legacyRegistryEngineRules)) {
    for (const rule of rules) {
      t.ok(schema.safeParse({ ...model, engine, tags: [rule.tag] }).success, engine)
    }
  }
})

test('submissions reject unsupported identities and ambiguous shared package ids', (t) => {
  for (const engine of [
    '',
    'embeddings',
    'llamacpp decision',
    'llamacpp-',
    '@qvac/',
    '@other/embed-llamacpp',
    'llamacpp-completon',
    'madeup-engine',
    '@qvac/not-a-plugin',
    'constructor',
    '__proto__',
    'toString',
    '@qvac/asr-ggml'
  ]) {
    const result = schema.safeParse({ ...model, engine })
    t.absent(result.success, engine)
    t.ok(result.error.issues.some((issue) => issue.path.includes('engine')))
  }
  t.absent(
    schema.safeParse({ ...model, engine: '@qvac/asr-ggml', tags: ['transcription'] }).success
  )
})

test('supported engines remain valid for every checked-in registry submission', (t) => {
  for (const name of ['prod', 'test']) {
    const rows = require(`../../data/models.${name}.json`)
    const rejected = rows.filter(
      (row) => !schema.safeParse({ ...model, engine: row.engine, tags: row.tags }).success
    )
    t.alike(rejected, [], `${name}: all ${rows.length} engine classifications remain valid`)
  }
})

test('validation runs from the registry package without a sibling SDK directory', (t) => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-registry-validation-'))
  t.teardown(() => fs.rmSync(isolated, { recursive: true, force: true }))
  const packageRoot = path.resolve(__dirname, '../..')
  const registry = path.join(isolated, 'registry-server')
  for (const file of [
    'scripts/validate-models-json.js',
    'lib/model-schema.js',
    'lib/source-helpers.js',
    'lib/generated/engine-manifest.json',
    'data/licenses.json',
    'data/hf-legacy-main-sources.json',
    'data/s3-legacy-paths.json'
  ]) {
    const target = path.join(registry, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(packageRoot, file), target)
  }
  // Reuse declared registry dependencies, without providing a sibling SDK tree.
  fs.symlinkSync(
    path.join(packageRoot, 'node_modules'),
    path.join(registry, 'node_modules'),
    'junction'
  )
  const entries = [
    { ...model, engine: 'llamacpp-completion' },
    {
      ...model,
      source: model.source.replace('model.gguf', 'legacy.gguf'),
      engine: '@qvac/embed-llamacpp'
    },
    {
      ...model,
      source: model.source.replace('model.gguf', 'shared.gguf'),
      engine: '@qvac/asr-ggml',
      tags: ['moss-transcribe']
    }
  ]
  fs.writeFileSync(path.join(registry, 'data/models.prod.json'), JSON.stringify(entries))
  t.absent(fs.existsSync(path.join(isolated, 'sdk')))
  const result = spawnSync(process.execPath, ['scripts/validate-models-json.js'], {
    cwd: registry,
    encoding: 'utf8'
  })
  t.is(result.status, 0, result.stderr || result.stdout)
  t.ok(result.stdout.includes('Valid: 3 model(s)'))
})
