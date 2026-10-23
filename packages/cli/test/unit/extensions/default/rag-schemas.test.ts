import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { z } from 'zod'
import {
  RAG_FIELD_CODES,
  addVectorsBody,
  chunkBody,
  createVectorIndexBody,
  ingestBody,
  loadVectorIndexBody,
  searchVectorsBody,
  vectorIdsBody,
  workspaceParams
} from '@/serve/extensions/default/schemas/rag'
import { createKeyedQueue } from '@/serve/extensions/default/routes/rag-workspaces'

function issuePaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to fail validation`)
  return result.error!.issues.map((i) => i.path.join('/'))
}

function accepts(schema: z.ZodType, input: unknown): void {
  const result = schema.safeParse(input)
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
}

describe('workspaceParams', () => {
  it('accepts vector-store-style names', () => {
    accepts(workspaceParams, { workspace: 'vs_0123abc' })
    accepts(workspaceParams, { workspace: 'my-docs' })
  })

  it('rejects traversal and other characters', () => {
    for (const workspace of ['..', 'a/b', 'a\\b', 'a.b', '', 'x'.repeat(65)]) {
      assert.deepEqual(issuePaths(workspaceParams, { workspace }), ['workspace'])
    }
  })
})

describe('chunkBody', () => {
  it('accepts one document or many, with chunk options', () => {
    accepts(chunkBody, { documents: 'one' })
    accepts(chunkBody, {
      documents: ['a', 'b'],
      chunkOpts: {
        chunkSize: 64,
        chunkOverlap: 8,
        chunkStrategy: 'paragraph',
        splitStrategy: 'word'
      }
    })
  })

  it('rejects empty documents', () => {
    assert.deepEqual(issuePaths(chunkBody, {}), ['documents'])
    assert.deepEqual(issuePaths(chunkBody, { documents: '' }), ['documents'])
    assert.deepEqual(issuePaths(chunkBody, { documents: [] }), ['documents'])
  })

  it('rejects unknown or inconsistent chunk options', () => {
    assert.deepEqual(issuePaths(chunkBody, { documents: 'a', chunkOpts: { size: 1 } }), [
      'chunkOpts'
    ])
    assert.deepEqual(
      issuePaths(chunkBody, { documents: 'a', chunkOpts: { chunkStrategy: 'sentence' } }),
      ['chunkOpts/chunkStrategy']
    )
    assert.deepEqual(
      issuePaths(chunkBody, { documents: 'a', chunkOpts: { chunkSize: 8, chunkOverlap: 8 } }),
      ['chunkOpts']
    )
  })
})

describe('ingestBody', () => {
  it('requires a model and documents', () => {
    accepts(ingestBody, { model: 'embed', documents: 'text', chunk: false })
    assert.deepEqual(issuePaths(ingestBody, { documents: 'text' }), ['model'])
  })

  it('rejects a model source', () => {
    assert.deepEqual(issuePaths(ingestBody, { model: 'e', documents: 'x', modelId: 'raw' }), [''])
  })
})

describe('createVectorIndexBody', () => {
  it('accepts TurboVec dimensions and any dimension for generic storage', () => {
    accepts(createVectorIndexBody, { dim: 768 })
    accepts(createVectorIndexBody, { dim: 1024, storage: 'turbovec-q2' })
    accepts(createVectorIndexBody, { dim: 3, storage: 'f32' })
    accepts(createVectorIndexBody, { dim: 4096, storage: 'q8' })
  })

  it('rejects a dimension TurboVec cannot hold, under dim', () => {
    assert.deepEqual(issuePaths(createVectorIndexBody, { dim: 3 }), ['dim'])
    assert.deepEqual(issuePaths(createVectorIndexBody, { dim: 2048, storage: 'turbovec-q4' }), [
      'dim'
    ])
  })

  it('rejects an unknown storage mode', () => {
    assert.deepEqual(issuePaths(createVectorIndexBody, { dim: 8, storage: 'q3' }), ['storage'])
  })
})

describe('snapshot names', () => {
  it('refuses paths', () => {
    for (const snapshot of ['/etc/passwd', '../x', 'a/b', 'x.qvi']) {
      assert.deepEqual(issuePaths(loadVectorIndexBody, { snapshot }), ['snapshot'])
    }
    accepts(loadVectorIndexBody, { snapshot: 'articles-2026' })
  })
})

describe('vector ids', () => {
  it('accepts decimal strings and safe integers', () => {
    accepts(vectorIdsBody, { ids: ['0', '18446744073709551614', 42] })
  })

  it('rejects the reserved id, overflow, negatives and padding', () => {
    for (const id of ['18446744073709551615', '99999999999999999999', '-1', '01', 1.5, -1]) {
      assert.deepEqual(issuePaths(vectorIdsBody, { ids: [id] }), ['ids/0'], String(id))
    }
    assert.deepEqual(issuePaths(vectorIdsBody, { ids: [] }), ['ids'])
  })

  it('needs at least one row to add or search', () => {
    assert.deepEqual(issuePaths(addVectorsBody, { ids: ['1'], vectors: [] }), ['vectors'])
    assert.deepEqual(issuePaths(searchVectorsBody, { queries: [[]], k: 1 }), ['queries/0'])
    assert.deepEqual(issuePaths(searchVectorsBody, { queries: [[1]], k: 0 }), ['k'])
  })
})

describe('RAG_FIELD_CODES', () => {
  it('gives every validated field its own code', () => {
    for (const field of ['workspace', 'documents', 'chunkOpts', 'dim', 'snapshot', 'ids', 'k']) {
      assert.match(RAG_FIELD_CODES[field] ?? '', /^invalid_/, field)
    }
  })
})

describe('createKeyedQueue', () => {
  it('runs calls for one key in order, and other keys alongside', async () => {
    const serialize = createKeyedQueue()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))

    const first = serialize('a', async () => {
      events.push('a1 start')
      await gate
      events.push('a1 end')
    })
    const second = serialize('a', () => {
      events.push('a2')
      return Promise.resolve()
    })
    await serialize('b', () => {
      events.push('b1')
      return Promise.resolve()
    })
    release()
    await Promise.all([first, second])

    assert.deepEqual(events, ['a1 start', 'b1', 'a1 end', 'a2'])
  })

  it('keeps going after a failed call', async () => {
    const serialize = createKeyedQueue()
    await assert.rejects(
      serialize('a', () => Promise.reject(new Error('boom'))),
      /boom/
    )
    assert.equal(await serialize('a', () => Promise.resolve('next')), 'next')
  })
})
