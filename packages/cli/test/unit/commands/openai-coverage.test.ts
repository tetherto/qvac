import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoverageReport, DEFAULT_ROUTER } from '@/openai/coverage/build-report'
import { categorize } from '@/openai/coverage/categorize'
import { filterCoverageRows, formatCoverageReportHuman } from '@/openai/coverage/format'
import { parseRouter } from '@/openai/coverage/parse-router'
import { parseSpec } from '@/openai/coverage/parse-spec'
import { CONSUMER_PRIMARY_ENDPOINTS } from '@/openai/coverage/primary'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')
const FIXTURE_SPEC = join(FIXTURE_DIR, 'openai-spec-mini.yaml')
const FIXTURE_ROUTER = join(FIXTURE_DIR, 'openai-router-mini.ts')

describe('openai coverage categorize', () => {
  it('assigns known categories deterministically', () => {
    assert.equal(categorize({ tags: ['Chat'], group: 'chat' }), 'primary-ai')
    assert.equal(categorize({ tags: ['Models'] }), 'ai-secondary')
    assert.equal(categorize({ tags: ['Assistants'] }), 'platform')
    assert.equal(categorize({ tags: ['NewlyAddedThing'] }), 'unknown')
  })

  it('maps x-oaiMeta.group slugs and tags case-insensitively', () => {
    assert.equal(categorize({ tags: [], group: 'containers' }), 'platform')
    assert.equal(categorize({ tags: [], group: 'chatkit' }), 'platform')
    assert.equal(categorize({ tags: ['Certificates'], group: 'administration' }), 'platform')
    assert.equal(categorize({ tags: [], group: 'responses' }), 'primary-ai')
    assert.equal(categorize({ tags: ['chat'] }), 'primary-ai')
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
    assert.equal(
      report.specSha256,
      createHash('sha256').update(readFileSync(FIXTURE_SPEC)).digest('hex')
    )
    assert.equal(report.summary.byCategory['unknown'].total, 1)
    assert.equal(report.rows.find((r) => r.tags.includes('NewlyAddedThing'))?.category, 'unknown')

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

  it('includes unknown breakdown when fixture has unknown ops', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    assert.ok(report.summary.unknownBreakdown)
    assert.ok(report.summary.unknownBreakdown.some((x) => x.label === 'NewlyAddedThing'))
  })

  it('omits unknown section and category line when nothing is unmapped', () => {
    const report = {
      fetchedAt: '2026-01-01T00:00:00.000Z',
      specSource: 'test',
      specSourceMode: 'file' as const,
      specSha256: 'a'.repeat(64),
      routerSource: 'test',
      implementedCount: 1,
      extensions: [],
      rows: [
        {
          method: 'POST' as const,
          path: '/v1/chat/completions',
          key: 'POST /v1/chat/completions',
          category: 'primary-ai' as const,
          consumerPrimary: true,
          implemented: true,
          deprecated: false,
          tags: ['Chat']
        }
      ],
      summary: {
        byCategory: {
          'primary-ai': { implemented: 1, total: 1, percent: 100 },
          'ai-secondary': { implemented: 0, total: 0, percent: 0 },
          platform: { implemented: 0, total: 0, percent: 0 },
          unknown: { implemented: 0, total: 0, percent: 0 }
        },
        consumerPrimary: { implemented: 1, total: 1, percent: 100 },
        full: { implemented: 1, total: 1, percent: 100 }
      }
    }
    const text = formatCoverageReportHuman(report, report.rows)
    assert.ok(!text.includes('Unmapped OpenAI spec labels'))
    assert.ok(!text.match(/^  unknown\s/m))
  })

  it('prints unmapped notice at top of human report when unknown ops exist', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    const text = formatCoverageReportHuman(report, report.rows)
    const titleIdx = text.indexOf('qvac serve openai — coverage')
    const noticeIdx = text.indexOf('Unmapped OpenAI spec labels')
    const specIdx = text.indexOf('Spec:')
    assert.ok(titleIdx >= 0)
    assert.ok(noticeIdx > titleIdx)
    assert.ok(specIdx > noticeIdx)
    assert.match(text, /do not map to any coverage category/)
    assert.match(text, /tag: NewlyAddedThing/)
  })

  it('filters unknown category rows', async () => {
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    const filtered = filterCoverageRows(report, { unknown: true })
    assert.ok(filtered.length > 0)
    for (const row of filtered) {
      assert.equal(row.category, 'unknown')
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

describe('openai coverage qvac extension endpoints', () => {
  it('reports known qvac-only endpoints separately instead of throwing', async () => {
    // Regression: GET /v1/audio/models and /v1/audio/voices are qvac-only
    // (Open WebUI compatibility) and are absent from the real OpenAI spec.
    const report = await buildCoverageReport({
      specPath: FIXTURE_SPEC,
      routerPath: FIXTURE_ROUTER
    })
    assert.deepEqual(report.extensions, ['GET /v1/audio/models'])
    assert.ok(!report.rows.some((r) => r.key === 'GET /v1/audio/models'))
  })
})

describe('openai coverage default router (real repo routes)', () => {
  it('DEFAULT_ROUTER resolves to an existing directory relative to the running module, not a hardcoded src/ sibling', () => {
    // Regression: DEFAULT_ROUTER used to hardcode a 'src' path segment, which
    // does not exist in the published npm package (only dist/ ships).
    const implementedKeys = parseRouter(DEFAULT_ROUTER)
    assert.ok(implementedKeys.includes('POST /v1/chat/completions'))
    assert.ok(implementedKeys.includes('POST /v1/embeddings'))
    assert.ok(implementedKeys.includes('GET /v1/models'))
    assert.ok(implementedKeys.includes('GET /v1/files'))
    assert.ok(implementedKeys.includes('POST /v1/files'))
    assert.ok(implementedKeys.includes('GET /v1/files/{file_id}'))
  })
})

describe('openai coverage parse-spec', () => {
  it('loads fixture spec without network and reports its exact SHA-256', async () => {
    const { entries, source, sha256 } = await parseSpec({ specPath: FIXTURE_SPEC })
    const expectedSha256 = createHash('sha256').update(readFileSync(FIXTURE_SPEC)).digest('hex')
    assert.equal(source, FIXTURE_SPEC)
    assert.equal(sha256, expectedSha256)
    assert.ok(entries.some((e) => e.path === '/v1/chat/completions'))
  })
})
