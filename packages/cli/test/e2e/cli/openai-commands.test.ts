import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli } from '../helpers/cli.js'
import { tempDir } from '../helpers/tmp.js'

describe('cli: openai spec', () => {
  it('emits a valid OpenAPI JSON document to stdout', async () => {
    const r = await runCli(['openai', 'spec'])
    assert.equal(r.code, 0)
    const doc = JSON.parse(r.stdout) as { openapi: string; paths: Record<string, unknown> }
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

// Runs against the built dist/index.js and the live upstream OpenAI spec —
// the only way to exercise the real default router path and catch spec drift
// (e.g. a qvac-only endpoint that isn't in QVAC_EXTENSION_ENDPOINTS).
describe('cli: openai coverage', () => {
  it('reports coverage against the live OpenAI spec with no errors', async () => {
    const r = await runCli(['openai', 'coverage'], { timeoutMs: 60_000 })
    assert.equal(r.code, 0, r.output)
    assert.ok(!r.output.includes('ENOENT'), r.output)
    assert.ok(r.stdout.includes('qvac serve openai — coverage'))
    assert.ok(r.stdout.includes('qvac extension endpoints beyond the OpenAI spec'))
    assert.ok(r.stdout.includes('GET /v1/audio/models'))
    assert.ok(r.stdout.includes('GET /v1/audio/voices'))
  })

  it('--json emits a valid coverage report with implemented routes and extensions', async () => {
    const r = await runCli(['openai', 'coverage', '--json'], { timeoutMs: 60_000 })
    assert.equal(r.code, 0, r.output)
    const report = JSON.parse(r.stdout) as {
      rows: Array<{ key: string; implemented: boolean }>
      extensions: string[]
    }
    assert.ok(report.rows.length > 0)
    const chat = report.rows.find((row) => row.key === 'POST /v1/chat/completions')
    assert.ok(chat)
    assert.equal(chat.implemented, true)
    assert.ok(report.extensions.includes('GET /v1/audio/models'))
    assert.ok(report.extensions.includes('GET /v1/audio/voices'))
  })
})
