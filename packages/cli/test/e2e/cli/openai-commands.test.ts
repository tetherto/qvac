import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli } from '../helpers/cli.js'
import { tempDir } from '../helpers/tmp.js'

// openai coverage is omitted — it needs network or a cached OpenAPI spec.
describe('cli: openai spec', () => {
  it('emits a valid OpenAPI JSON document to stdout', async () => {
    const r = await runCli(['openai', 'spec'])
    assert.equal(r.code, 0)
    const doc = JSON.parse(r.stdout) as { openapi: string, paths: Record<string, unknown> }
    assert.match(doc.openapi, /^3\./)
    assert.ok('/v1/chat/completions' in doc.paths)
    assert.ok('/v1/models' in doc.paths)
  })

  it('--yaml emits YAML', async () => {
    const r = await runCli(['openai', 'spec', '--yaml'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /^openapi:/m)
    assert.ok(r.stdout.includes('/v1/chat/completions'))
    // Not JSON.
    assert.throws(() => JSON.parse(r.stdout))
  })

  it('-o writes the spec to a file instead of stdout', async (t) => {
    const dir = await tempDir(t, 'qvac-cli-openai-')
    const out = join(dir, 'openapi.json')
    const r = await runCli(['openai', 'spec', '-o', out])
    assert.equal(r.code, 0)
    const doc = JSON.parse(await readFile(out, 'utf8')) as { openapi: string }
    assert.match(doc.openapi, /^3\./)
  })
})
