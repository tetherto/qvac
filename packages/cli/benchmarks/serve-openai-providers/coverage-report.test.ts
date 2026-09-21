import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { captureOpenAiApiCoverage } from './coverage'
import { generateOpenAiCoveragePreview, outputDirectory } from './coverage-preview'
import { writeOpenAiCoveragePreview, writeReport } from './report'
import type { RawDocument } from './types'
import type { CoverageReport } from '../../src/openai/coverage/types'

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))

function makeCoverageReport(): CoverageReport {
  return {
    fetchedAt: '2026-08-03T00:00:00.000Z',
    specSource: 'https://example.test/openai.yaml',
    specSourceMode: 'live',
    specSha256: 'b'.repeat(64),
    routerSource: '/repo/packages/cli/src/serve/routes',
    implementedCount: 3,
    extensions: ['GET /v1/audio/models'],
    rows: [
      {
        method: 'POST',
        path: '/v1/chat/completions',
        key: 'POST /v1/chat/completions',
        category: 'primary-ai',
        consumerPrimary: true,
        implemented: true,
        deprecated: false,
        tags: ['Chat']
      },
      {
        method: 'POST',
        path: '/v1/realtime/sessions',
        key: 'POST /v1/realtime/sessions',
        category: 'primary-ai',
        consumerPrimary: true,
        implemented: false,
        deprecated: false,
        tags: ['Realtime']
      },
      {
        method: 'POST',
        path: '/v1/audio/translations',
        key: 'POST /v1/audio/translations',
        category: 'primary-ai',
        consumerPrimary: false,
        implemented: false,
        deprecated: false,
        tags: ['Audio']
      }
    ],
    summary: {
      byCategory: {
        'primary-ai': { implemented: 1, total: 3, percent: 33.3 },
        'ai-secondary': { implemented: 0, total: 0, percent: 0 },
        platform: { implemented: 0, total: 0, percent: 0 },
        unknown: { implemented: 0, total: 0, percent: 0 }
      },
      consumerPrimary: { implemented: 1, total: 2, percent: 50 },
      full: { implemented: 1, total: 3, percent: 33.3 }
    }
  }
}

describe('OpenAI API capability coverage report', () => {
  it('captures stable headline metrics and exact uncovered endpoint keys', async () => {
    const calls: Array<{ offline?: boolean }> = []

    const snapshot = await captureOpenAiApiCoverage((options = {}) => {
      calls.push(options)
      return Promise.resolve(makeCoverageReport())
    })

    assert.deepEqual(calls, [{}])
    assert.equal(snapshot.status, 'available')
    if (snapshot.status !== 'available') return
    assert.equal(snapshot.source_mode, 'live')
    assert.equal(snapshot.spec_sha256, 'b'.repeat(64))
    assert.equal(snapshot.spec_endpoint_count, 3)
    assert.deepEqual(snapshot.consumer_primary, {
      implemented: 1,
      total: 2,
      percent: 50,
      uncovered: ['POST /v1/realtime/sessions']
    })
    assert.deepEqual(snapshot.primary_ai, {
      implemented: 1,
      total: 3,
      percent: 33.3,
      uncovered: ['POST /v1/audio/translations', 'POST /v1/realtime/sessions']
    })
    assert.deepEqual(snapshot.extensions, ['GET /v1/audio/models'])
    assert.deepEqual(snapshot.warnings, [])
  })

  it('falls back to the cached spec and records the live-fetch failure', async () => {
    const calls: Array<{ offline?: boolean }> = []

    const snapshot = await captureOpenAiApiCoverage((options = {}) => {
      calls.push(options)
      if (!options.offline) {
        return Promise.reject(new Error('network unavailable'))
      }
      return Promise.resolve({
        ...makeCoverageReport(),
        specSourceMode: 'offline-cache'
      })
    })

    assert.deepEqual(calls, [{}, { offline: true }])
    assert.equal(snapshot.status, 'available')
    if (snapshot.status !== 'available') return
    assert.equal(snapshot.source_mode, 'offline-cache')
    assert.deepEqual(snapshot.warnings, [
      'Live OpenAI coverage build failed; used offline specification cache: network unavailable'
    ])
  })

  it('returns an unavailable snapshot when live and cached specs both fail', async () => {
    const snapshot = await captureOpenAiApiCoverage(
      (options = {}) =>
        Promise.reject(new Error(options.offline ? 'cache missing' : 'network unavailable')),
      () => new Date('2026-08-03T12:00:00.000Z')
    )

    assert.deepEqual(snapshot, {
      status: 'unavailable',
      captured_at: '2026-08-03T12:00:00.000Z',
      errors: [
        'Live OpenAI coverage build failed: network unavailable',
        'Offline OpenAI coverage build failed: cache missing'
      ]
    })
  })

  it('renders coverage metrics, provenance, gaps, extensions, and the static-coverage caveat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-coverage-report-'))
    try {
      const path = join(dir, 'report.md')
      const raw = {
        session_id: 'coverage-session',
        created_at: '2026-08-03T00:00:00.000Z',
        config_snapshot: {
          generation: {},
          cooldown_seconds: 0,
          prompt_ids: [],
          providers: [],
          model_parity: { gguf_path: '/tmp/model.gguf' }
        },
        provider_order: [],
        parity: {},
        runs: [],
        openai_api_coverage: {
          status: 'available',
          source_mode: 'live',
          captured_at: '2026-08-03T00:00:00.000Z',
          spec_source: 'https://example.test/openai.yaml',
          spec_sha256: 'a'.repeat(64),
          spec_endpoint_count: 100,
          router_source: '/repo/packages/cli/src/serve/routes',
          router_implemented_count: 12,
          consumer_primary: {
            implemented: 10,
            total: 12,
            percent: 83.3,
            uncovered: ['POST /v1/realtime/sessions', 'POST /v1/videos/edits']
          },
          primary_ai: {
            implemented: 11,
            total: 20,
            percent: 55,
            uncovered: ['POST /v1/audio/translations']
          },
          extensions: ['GET /v1/audio/models'],
          warnings: []
        }
      } as RawDocument

      writeReport(raw, path)

      const report = readFileSync(path, 'utf8')
      assert.ok(report.includes('## OpenAI API capability coverage'))
      assert.ok(report.includes('Consumer-primary: 10 / 12 (83.3%)'))
      assert.ok(report.includes('Primary-AI: 11 / 20 (55.0%)'))
      assert.ok(report.includes(`Spec SHA-256: \`${'a'.repeat(64)}\``))
      assert.ok(report.includes('`POST /v1/realtime/sessions`'))
      assert.ok(report.includes('`GET /v1/audio/models`'))
      assert.ok(
        report.includes(
          'Static route coverage only: route presence does not prove behavioral compatibility with OpenAI.'
        )
      )
      assert.equal(report.endsWith('\n'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes a provider-free preview using the production coverage section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-coverage-preview-'))
    try {
      const path = join(dir, 'report.md')
      const snapshot = await captureOpenAiApiCoverage(() => Promise.resolve(makeCoverageReport()))

      writeOpenAiCoveragePreview(snapshot, path)

      const report = readFileSync(path, 'utf8')
      assert.ok(report.startsWith('# OpenAI API capability coverage preview\n'))
      assert.ok(
        report.includes(
          'Preview only: no model, provider, performance benchmark, deployment, or publishing step ran.'
        )
      )
      assert.ok(report.includes('## OpenAI API capability coverage'))
      assert.ok(report.includes('Consumer-primary: 1 / 2 (50.0%)'))
      assert.ok(report.includes(`Spec SHA-256: \`${'b'.repeat(64)}\``))
      assert.equal(report.includes('## Median and IQR tables by prompt size'), false)
      assert.equal(report.endsWith('\n'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults preview output to the benchmark results directory', () => {
    assert.equal(outputDirectory([]), join(BENCHMARK_DIR, 'results', 'coverage-preview'))
  })

  it('generates CI preview JSON and Markdown artifacts without providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-coverage-preview-artifact-'))
    try {
      const expected = await captureOpenAiApiCoverage(() => Promise.resolve(makeCoverageReport()))

      const snapshot = await generateOpenAiCoveragePreview(dir, () => Promise.resolve(expected))

      assert.deepEqual(snapshot, expected)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'coverage.json'), 'utf8')), expected)
      assert.ok(
        readFileSync(join(dir, 'report.md'), 'utf8').includes(
          'Preview only: no model, provider, performance benchmark, deployment, or publishing step ran.'
        )
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders a legacy raw artifact without attempting to reconstruct coverage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-coverage-report-'))
    try {
      const path = join(dir, 'report.md')
      const raw: RawDocument = {
        session_id: 'legacy-session',
        created_at: '2026-07-22T00:00:00.000Z',
        config_snapshot: {
          generation: {},
          prompt_ids: [],
          providers: [],
          model_parity: { gguf_path: '/tmp/model.gguf' }
        },
        provider_order: [],
        parity: {},
        runs: []
      }

      writeReport(raw, path)

      assert.ok(
        readFileSync(path, 'utf8').includes(
          'Coverage snapshot: unavailable (not captured in this benchmark artifact).'
        )
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
