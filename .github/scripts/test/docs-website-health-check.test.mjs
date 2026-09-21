import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSitemapLocs,
  rebaseToOrigin,
  toMarkdownSibling,
  parseRedirectSources,
  buildUrlSet,
  probeUrl,
  runProbes,
  formatSummary
} from '../docs-website-health-check.mjs'

const ORIGIN = 'https://docs.qvac.tether.io'

test('parseSitemapLocs extracts every <loc> and decodes entities', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://docs.qvac.tether.io/</loc></url>
      <url><loc>https://docs.qvac.tether.io/quickstart/</loc><lastmod>2026-01-01</lastmod></url>
      <url>
        <loc>
          https://docs.qvac.tether.io/reference/api/
        </loc>
      </url>
      <url><loc>https://docs.qvac.tether.io/search/?q=a&amp;b=c</loc></url>
    </urlset>`
  assert.deepEqual(parseSitemapLocs(xml), [
    'https://docs.qvac.tether.io/',
    'https://docs.qvac.tether.io/quickstart/',
    'https://docs.qvac.tether.io/reference/api/',
    'https://docs.qvac.tether.io/search/?q=a&b=c'
  ])
})

test('parseSitemapLocs tolerates non-string and empty input', () => {
  assert.deepEqual(parseSitemapLocs(null), [])
  assert.deepEqual(parseSitemapLocs('<urlset></urlset>'), [])
})

test('rebaseToOrigin keeps only the path', () => {
  assert.equal(
    rebaseToOrigin('https://docs.qvac.tether.io/quickstart/', 'https://docs.qvac.tether.su'),
    'https://docs.qvac.tether.su/quickstart/'
  )
  assert.equal(
    rebaseToOrigin('https://docs.qvac.tether.io/', ORIGIN),
    'https://docs.qvac.tether.io/'
  )
})

test('toMarkdownSibling mirrors generate-llm-md-files mapping', () => {
  assert.equal(toMarkdownSibling(`${ORIGIN}/`), `${ORIGIN}/index.md`)
  assert.equal(toMarkdownSibling(`${ORIGIN}/quickstart/`), `${ORIGIN}/quickstart.md`)
  assert.equal(
    toMarkdownSibling(`${ORIGIN}/ai-capabilities/text-generation/`),
    `${ORIGIN}/ai-capabilities/text-generation.md`
  )
  // Trailing slash tolerated / optional.
  assert.equal(toMarkdownSibling(`${ORIGIN}/reference/api`), `${ORIGIN}/reference/api.md`)
})

test('parseRedirectSources keeps only literal 301 sources', () => {
  const redirects = [
    '# comment line',
    '',
    '/                       /index.md                  303!   Header:Accept=text/markdown',
    '/:a/                    /:a.md                     303!   Header:Accept=text/markdown',
    '/reference/api/:version/             /reference/api/:version/index.html             200',
    '/reference/api/:version              /reference/api/:version/                       301',
    '/about-qvac/how-it-works/    /about/how-it-works/         301',
    '/sdk/getting-started/quickstart/     /quickstart/      301',
    '/http-server/   /cli/http-server/   301',
    '/*   /404.html   404'
  ].join('\n')

  assert.deepEqual(parseRedirectSources(redirects), [
    '/about-qvac/how-it-works/',
    '/sdk/getting-started/quickstart/',
    '/http-server/'
  ])
})

test('parseRedirectSources tolerates non-string input', () => {
  assert.deepEqual(parseRedirectSources(undefined), [])
})

test('buildUrlSet unions sitemap, markdown siblings, redirects and llms, deduped', () => {
  const sitemapXml = `<urlset>
    <url><loc>${ORIGIN}/</loc></url>
    <url><loc>${ORIGIN}/quickstart/</loc></url>
  </urlset>`
  const redirectsText = '/old-path/   /quickstart/   301\n/*   /404.html   404\n'

  const entries = buildUrlSet({ origin: ORIGIN, sitemapXml, redirectsText })
  const byUrl = new Map(entries.map((e) => [e.url, e.category]))

  assert.equal(byUrl.get(`${ORIGIN}/`), 'sitemap')
  assert.equal(byUrl.get(`${ORIGIN}/index.md`), 'markdown')
  assert.equal(byUrl.get(`${ORIGIN}/quickstart/`), 'sitemap')
  assert.equal(byUrl.get(`${ORIGIN}/quickstart.md`), 'markdown')
  assert.equal(byUrl.get(`${ORIGIN}/old-path/`), 'redirect')
  assert.equal(byUrl.get(`${ORIGIN}/llms.txt`), 'llms')
  assert.equal(byUrl.get(`${ORIGIN}/llms-full.txt`), 'llms')

  // No duplicates.
  assert.equal(entries.length, byUrl.size)
})

test('buildUrlSet rebases sitemap URLs onto a different origin', () => {
  const sitemapXml = `<urlset><url><loc>${ORIGIN}/quickstart/</loc></url></urlset>`
  const entries = buildUrlSet({
    origin: 'https://docs.qvac.tether.su',
    sitemapXml,
    redirectsText: ''
  })
  const urls = new Set(entries.map((e) => e.url))
  assert.ok(urls.has('https://docs.qvac.tether.su/quickstart/'))
  assert.ok(urls.has('https://docs.qvac.tether.su/quickstart.md'))
  // Every collected URL must live on the requested origin (nothing left on .io).
  for (const url of urls) {
    assert.equal(new URL(url).origin, 'https://docs.qvac.tether.su')
  }
})

test('probeUrl reports ok for 2xx and failure for 4xx', async () => {
  const fetchImpl = async (url) => new Response('', { status: url.endsWith('.md') ? 404 : 200 })
  const good = await probeUrl(`${ORIGIN}/quickstart/`, { fetchImpl })
  const bad = await probeUrl(`${ORIGIN}/quickstart.md`, { fetchImpl })
  assert.deepEqual(good, { url: `${ORIGIN}/quickstart/`, status: 200, ok: true, error: null })
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 404)
})

test('probeUrl captures network errors without throwing', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const res = await probeUrl(`${ORIGIN}/`, { fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.status, null)
  assert.match(res.error, /ECONNREFUSED/)
})

test('probeUrl reports a timeout when the request aborts', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  const res = await probeUrl(`${ORIGIN}/`, { fetchImpl, timeoutMs: 10 })
  assert.equal(res.ok, false)
  assert.match(res.error, /timeout after 10ms/)
})

test('runProbes preserves order and attaches category', async () => {
  const entries = [
    { url: `${ORIGIN}/`, category: 'sitemap' },
    { url: `${ORIGIN}/index.md`, category: 'markdown' },
    { url: `${ORIGIN}/llms.txt`, category: 'llms' }
  ]
  const fetchImpl = async (url) => new Response('', { status: url.endsWith('index.md') ? 500 : 200 })
  const results = await runProbes(entries, { fetchImpl, concurrency: 2 })
  assert.equal(results.length, 3)
  assert.equal(results[0].category, 'sitemap')
  assert.equal(results[1].category, 'markdown')
  assert.equal(results[1].ok, false)
  assert.equal(results[2].category, 'llms')
})

test('formatSummary renders a clean report with no failures', () => {
  const results = [
    { url: `${ORIGIN}/`, status: 200, ok: true, error: null, category: 'sitemap' },
    { url: `${ORIGIN}/index.md`, status: 200, ok: true, error: null, category: 'markdown' }
  ]
  const summary = formatSummary({ origin: ORIGIN, results, redirectsSource: 'file' })
  assert.match(summary, /URLs probed: 2/)
  assert.match(summary, /Failures: 0/)
  assert.match(summary, /No broken URLs detected/)
  assert.doesNotMatch(summary, /## Broken URLs/)
})

test('formatSummary lists broken URLs when failures exist', () => {
  const results = [
    { url: `${ORIGIN}/`, status: 200, ok: true, error: null, category: 'sitemap' },
    { url: `${ORIGIN}/dead/`, status: 404, ok: false, error: null, category: 'redirect' },
    { url: `${ORIGIN}/slow.md`, status: null, ok: false, error: 'timeout after 15000ms', category: 'markdown' }
  ]
  const summary = formatSummary({ origin: ORIGIN, results, redirectsSource: 'file' })
  assert.match(summary, /Failures: 2/)
  assert.match(summary, /## Broken URLs/)
  assert.match(summary, /404 \| redirect \| https:\/\/docs\.qvac\.tether\.io\/dead\//)
  assert.match(summary, /timeout after 15000ms \| markdown \| https:\/\/docs\.qvac\.tether\.io\/slow\.md/)
})
