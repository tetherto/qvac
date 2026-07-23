import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitOpenApiSpec, renderOpenApiSpec } from '../src/openai/spec.js'

describe('renderOpenApiSpec', () => {
  it('returns a valid OpenAPI 3.1.0 JSON string by default', async () => {
    const text = await renderOpenApiSpec()
    const doc = JSON.parse(text) as { openapi: string; paths: Record<string, unknown> }
    assert.match(doc.openapi, /^3\./)
    assert.ok(doc.paths['/v1/chat/completions'])
    assert.ok(doc.paths['/v1/embeddings'])
    assert.ok(doc.paths['/v1/models'])
  })

  it('returns YAML when format is yaml', async () => {
    const text = await renderOpenApiSpec('yaml')
    assert.ok(text.startsWith('openapi:'))
    assert.match(text, /paths:/)
    assert.match(text, /\/v1\/chat\/completions:/)
  })

  it('includes per-route descriptions (e.g. mask_not_supported on images/edits)', async () => {
    const text = await renderOpenApiSpec()
    const doc = JSON.parse(text) as { paths: Record<string, { post?: { description?: string } }> }
    const editsDesc = doc.paths['/v1/images/edits']?.post?.description ?? ''
    assert.match(editsDesc, /mask_not_supported|mask inpainting/i)
  })

  it('includes tag descriptions', async () => {
    const text = await renderOpenApiSpec()
    const doc = JSON.parse(text) as { tags?: Array<{ name: string; description?: string }> }
    assert.ok(doc.tags && doc.tags.length > 0)
    const responsesTag = doc.tags.find((t) => t.name === 'Responses')
    assert.ok(responsesTag?.description)
    assert.match(responsesTag.description, /in-memory|volatile/i)
  })

  it('JSON output ends with a trailing newline (pipe-friendly)', async () => {
    const text = await renderOpenApiSpec()
    assert.ok(text.endsWith('\n'))
  })
})

describe('emitOpenApiSpec', () => {
  it('writes JSON to file when output is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvac-spec-'))
    const path = join(dir, 'spec.json')
    try {
      await emitOpenApiSpec({ output: path })
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        openapi: string
        paths: Record<string, unknown>
      }
      assert.match(doc.openapi, /^3\./)
      assert.ok(Object.keys(doc.paths).length >= 10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes YAML to file when format=yaml + output is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvac-spec-'))
    const path = join(dir, 'spec.yaml')
    try {
      await emitOpenApiSpec({ output: path, format: 'yaml' })
      const text = readFileSync(path, 'utf8')
      assert.ok(text.startsWith('openapi:'))
      assert.match(text, /\/v1\/chat\/completions:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
