import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoverageReport } from '../src/openai/coverage/build-report.js'
import { categorize } from '../src/openai/coverage/categorize.js'
import { collectMeta } from '../src/openai/coverage/collect-meta.js'
import { filterCoverageRows } from '../src/openai/coverage/format.js'
import { parseRouter } from '../src/openai/coverage/parse-router.js'
import { parseSpec } from '../src/openai/coverage/parse-spec.js'
import { CONSUMER_PRIMARY_ENDPOINTS } from '../src/openai/coverage/primary.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_SPEC = join(TEST_DIR, 'fixtures', 'openai-spec-mini.yaml')
const FIXTURE_ROUTER = join(TEST_DIR, 'fixtures', 'openai-router-mini.ts')

describe('openai coverage categorize', () => {
  it('assigns known categories deterministically', () => {
    assert.equal(categorize({ tags: ['Chat'], group: 'chat' }), 'primary-ai')
    assert.equal(categorize({ tags: ['Models'] }), 'ai-secondary')
    assert.equal(categorize({ tags: ['Assistants'] }), 'platform')
    assert.equal(categorize({ tags: ['NewlyAddedThing'] }), 'unknown')
  })
})

describe('openai coverage parse-router', () => {
  it('extracts templates from fixture router text', () => {
    const keys = parseRouter(FIXTURE_ROUTER)
    assert.ok(keys.includes('POST /v1/chat/completions'))
    assert.ok(keys.includes('POST /v1/embeddings'))
    assert.ok(keys.includes('GET /v1/models'))
    assert.ok(keys.includes('GET /v1/files'))
    assert.ok(keys.includes('POST /v1/files'))
    assert.ok(keys.includes('GET /v1/files/{file_id}'))
  })
})

describe('openai coverage live report (fixture)', () => {
  it('builds a report from fixture spec and router', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })

    assert.ok(report.rows.length > 0)
    assert.equal(report.summary.byCategory['unknown'].total, 1)
    assert.equal(
      report.rows.find((r) => r.tags.includes('NewlyAddedThing'))?.category,
      'unknown'
    )

    const categories = ['primary-ai', 'ai-secondary', 'platform', 'unknown'] as const
    for (const cat of categories) {
      assert.ok(report.summary.byCategory[cat])
    }

    const chat = report.rows.find((r) => r.key === 'POST /v1/chat/completions')
    assert.ok(chat)
    assert.equal(chat.implemented, true)
    assert.equal(chat.consumerPrimary, true)

    const assistants = report.rows.find((r) => r.key === 'POST /v1/assistants')
    assert.ok(assistants)
    assert.equal(assistants.implemented, false)

    const filesGet = report.rows.find((r) => r.key === 'GET /v1/files')
    assert.ok(filesGet)
    assert.equal(filesGet.implemented, true)
    assert.ok(filesGet.caveats.includes('ephemeral in-memory store'))
  })

  it('filters consumer-primary rows', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    const filtered = filterCoverageRows(report, { consumerPrimary: true })
    assert.ok(filtered.length > 0)
    for (const row of filtered) {
      assert.equal(CONSUMER_PRIMARY_ENDPOINTS.has(row.key), true)
    }
  })

  it('filters primary-ai category rows', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    const filtered = filterCoverageRows(report, { primaryAi: true })
    assert.ok(filtered.length > 0)
    for (const row of filtered) {
      assert.equal(row.category, 'primary-ai')
    }
    assert.ok(filtered.some((r) => r.key === 'POST /v1/chat/completions'))
    assert.ok(!filtered.some((r) => r.key === 'GET /v1/models'))
  })
})

describe('openai coverage parse-spec', () => {
  it('loads fixture spec without network', async () => {
    const { entries, source } = await parseSpec({ specPath: FIXTURE_SPEC })
    assert.equal(source, FIXTURE_SPEC)
    assert.ok(entries.some((e) => e.path === '/v1/chat/completions'))
  })
})

describe('openai coverage collect-meta', () => {
  it('aggregates route META exports', () => {
    const meta = collectMeta()
    assert.ok(meta.get('POST /v1/audio/speech')?.length)
    assert.ok(meta.get('GET /v1/files')?.includes('ephemeral in-memory store'))
  })
})
