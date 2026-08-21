#!/usr/bin/env node
/**
 * Daily production health-check for the QVAC docs site
 * (https://docs.qvac.tether.io). Collects the set of URLs a reader or crawler
 * is expected to reach and probes each one, failing the process if any returns
 * a 404 (or other >= 400 status / network error).
 *
 * URL set (per QVAC-20429):
 *   1. Every `<loc>` in the live `/sitemap.xml`.
 *   2. The Markdown sibling of each sitemap page (`/` -> `/index.md`,
 *      `/quickstart/` -> `/quickstart.md`), mirroring the content-negotiation
 *      mapping in `docs/website/public/_redirects` and the file layout produced
 *      by `docs/website/scripts/generate-llm-md-files.ts`.
 *   3. Every literal permanent-redirect (`301`) source in `_redirects`
 *      (placeholder / splat / content-negotiation rules are skipped — they
 *      cannot be probed as a concrete URL).
 *   4. `/llms.txt` and `/llms-full.txt`.
 *
 * Requests follow redirects, so a `301` source that ultimately resolves to a
 * live page passes, while one whose target 404s fails. Uses GET (not HEAD):
 * static CDNs frequently mishandle HEAD.
 *
 * The list of broken URLs is written to stdout and the GitHub Actions step
 * summary — never to Slack or an issue body (see the ticket's security
 * discussion: a Slack webhook in a public repo is a leak risk).
 *
 * Zero runtime dependencies (Node 20+ global `fetch`). Pure helpers are
 * exported for unit testing.
 *
 * Usage:
 *   node .github/scripts/docs-website-health-check.mjs \
 *     [--origin https://docs.qvac.tether.io] \
 *     [--redirects-url <raw _redirects URL>] \
 *     [--redirects-file docs/website/public/_redirects] \
 *     [--timeout-ms 15000] [--concurrency 10]
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const DEFAULT_ORIGIN = 'https://docs.qvac.tether.io'
export const DEFAULT_REDIRECTS_URL =
  'https://raw.githubusercontent.com/tetherto/qvac/docs-production/docs/website/public/_redirects'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_CONCURRENCY = 10
const USER_AGENT = 'qvac-docs-health-check (+https://github.com/tetherto/qvac)'

/** Extract every `<loc>` value from a sitemap XML string. */
export function parseSitemapLocs (xml) {
  if (typeof xml !== 'string') return []
  const locs = []
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g
  let match
  while ((match = re.exec(xml)) !== null) {
    locs.push(decodeXmlEntities(match[1]))
  }
  return locs
}

function decodeXmlEntities (value) {
  // `&amp;` is decoded LAST so a decoded `&` cannot recombine with following
  // characters into another entity that then gets decoded again (double
  // unescaping): e.g. `&amp;lt;` must yield literal `&lt;`, not `<`.
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Rebase any absolute URL onto `origin`, preserving only its path. */
export function rebaseToOrigin (url, origin) {
  const path = new URL(url).pathname
  return new URL(path, origin).toString()
}

/**
 * Map a page URL to its Markdown sibling, matching
 * `urlToMarkdownRelativePath` in `generate-llm-md-files.ts`:
 *   `/`             -> `/index.md`
 *   `/quickstart/`  -> `/quickstart.md`
 *   `/a/b/`         -> `/a/b.md`
 */
export function toMarkdownSibling (pageUrl) {
  const u = new URL(pageUrl)
  const trimmed = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  u.pathname = trimmed.length === 0 ? '/index.md' : `/${trimmed}.md`
  u.search = ''
  u.hash = ''
  return u.toString()
}

/**
 * Parse literal permanent-redirect (`301`) source paths from a Sevalla-style
 * `_redirects` file. Skips comments, blank lines, non-301 rules, and any source
 * containing a `:placeholder` or `*` splat (not a concrete, probeable URL).
 */
export function parseRedirectSources (text) {
  if (typeof text !== 'string') return []
  const sources = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const [source, , status] = parts
    if (status !== '301') continue
    if (source.includes(':') || source.includes('*')) continue
    sources.push(source)
  }
  return sources
}

/**
 * Build the deduplicated set of `{ url, category }` entries to probe. First
 * category wins on collision. Pure — inputs are already-fetched strings.
 */
export function buildUrlSet ({ origin, sitemapXml, redirectsText }) {
  const seen = new Map()
  const add = (url, category) => {
    if (!seen.has(url)) seen.set(url, category)
  }

  for (const loc of parseSitemapLocs(sitemapXml)) {
    const page = rebaseToOrigin(loc, origin)
    add(page, 'sitemap')
    add(toMarkdownSibling(page), 'markdown')
  }

  for (const source of parseRedirectSources(redirectsText || '')) {
    add(new URL(source, origin).toString(), 'redirect')
  }

  add(new URL('/llms.txt', origin).toString(), 'llms')
  add(new URL('/llms-full.txt', origin).toString(), 'llms')

  return [...seen.entries()].map(([url, category]) => ({ url, category }))
}

/** Probe a single URL. Never throws — failures are returned as data. */
export async function probeUrl (url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT }
    })
    // Free the socket without downloading the full body (llms-full.txt is large).
    try { await res.body?.cancel() } catch {}
    return { url, status: res.status, ok: res.status < 400, error: null }
  } catch (err) {
    const error = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || String(err))
    return { url, status: null, ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe every entry with a bounded worker pool, preserving input order. */
export async function runProbes (entries, { concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const results = new Array(entries.length)
  let next = 0
  async function worker () {
    while (next < entries.length) {
      const index = next++
      const { url, category } = entries[index]
      const result = await probeUrl(url, { timeoutMs, fetchImpl })
      results[index] = { ...result, category }
    }
  }
  const size = Math.max(1, Math.min(concurrency, entries.length))
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

function countByCategory (results) {
  const counts = new Map()
  for (const { category } of results) {
    counts.set(category, (counts.get(category) || 0) + 1)
  }
  return counts
}

/** Render a Markdown report for the GitHub Actions step summary. */
export function formatSummary ({ origin, results, redirectsSource }) {
  const failures = results.filter((r) => !r.ok)
  const counts = countByCategory(results)
  const lines = []
  lines.push('# Docs site health check')
  lines.push('')
  lines.push(`- Origin: ${origin}`)
  lines.push(`- Redirects source: ${redirectsSource || 'none'}`)
  lines.push(`- URLs probed: ${results.length}`)
  lines.push(`- Failures: ${failures.length}`)
  lines.push('')
  lines.push('| Category | Probed |')
  lines.push('| --- | ---: |')
  for (const category of [...counts.keys()].sort()) {
    lines.push(`| ${category} | ${counts.get(category)} |`)
  }
  lines.push('')
  if (failures.length === 0) {
    lines.push('All pages returned a healthy status. No broken URLs detected.')
  } else {
    lines.push('## Broken URLs')
    lines.push('')
    lines.push('| Status | Category | URL |')
    lines.push('| --- | --- | --- |')
    for (const f of failures) {
      lines.push(`| ${f.status ?? f.error} | ${f.category} | ${f.url} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function parseArgs (argv) {
  const args = {
    origin: DEFAULT_ORIGIN,
    redirectsUrl: DEFAULT_REDIRECTS_URL,
    redirectsFile: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--origin') args.origin = argv[++i]
    else if (arg === '--redirects-url') args.redirectsUrl = argv[++i]
    else if (arg === '--redirects-file') args.redirectsFile = argv[++i]
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  args.origin = args.origin.replace(/\/+$/, '')
  return args
}

async function fetchText (url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT }
    })
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function loadRedirects (args) {
  if (args.redirectsUrl) {
    try {
      const text = await fetchText(args.redirectsUrl, args.timeoutMs)
      return { text, source: args.redirectsUrl }
    } catch (err) {
      console.warn(`warning: could not fetch _redirects from ${args.redirectsUrl} (${err.message})`)
    }
  }
  if (args.redirectsFile) {
    try {
      const path = resolve(process.cwd(), args.redirectsFile)
      return { text: readFileSync(path, 'utf8'), source: args.redirectsFile }
    } catch (err) {
      console.warn(`warning: could not read _redirects file ${args.redirectsFile} (${err.message})`)
    }
  }
  console.warn('warning: proceeding without redirect coverage (no _redirects source available)')
  return { text: '', source: '' }
}

function writeStepSummary (markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    appendFileSync(path, `${markdown}\n`)
  } catch {
    // Best-effort: never fail the check because the summary could not be written.
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  console.log(`Docs health check against ${args.origin}`)

  let sitemapXml
  try {
    sitemapXml = await fetchText(new URL('/sitemap.xml', args.origin).toString(), args.timeoutMs)
  } catch (err) {
    console.error(`error: could not fetch sitemap from ${args.origin}/sitemap.xml (${err.message})`)
    process.exit(1)
  }

  const { text: redirectsText, source: redirectsSource } = await loadRedirects(args)

  const entries = buildUrlSet({ origin: args.origin, sitemapXml, redirectsText })
  if (entries.length === 0) {
    console.error('error: no URLs collected — sitemap parsing likely failed')
    process.exit(1)
  }

  console.log(`Probing ${entries.length} URL(s) with concurrency ${args.concurrency}…`)
  const results = await runProbes(entries, {
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs
  })

  const failures = results.filter((r) => !r.ok)
  const summary = formatSummary({ origin: args.origin, results, redirectsSource })
  writeStepSummary(summary)

  if (failures.length === 0) {
    console.log(`OK — all ${results.length} URL(s) healthy.`)
    return
  }

  console.error(`FAILED — ${failures.length} of ${results.length} URL(s) broken:`)
  for (const f of failures) {
    console.error(`  [${f.category}] ${f.url} -> ${f.status ?? f.error}`)
  }
  process.exit(1)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`docs-website-health-check: ${err.stack || err.message}`)
    process.exit(2)
  })
}
