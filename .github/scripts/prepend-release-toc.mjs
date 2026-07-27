#!/usr/bin/env node
// Insert a clickable Table of Contents into a GitHub-release notes file.
//
// The ToC is placed after the summary (the NPM line + intro paragraph that open the
// notes) and immediately before the first `##`/`###` content section.
//
// The release pipeline (create-github-release.yml) extracts a version's changelog
// section into a temporary notes file (via the verify-changelog-notes action) and
// feeds it to softprops/action-gh-release as the release body. This script runs on
// that temporary file only: it never touches any committed changelog. That keeps the
// ToC scoped to the published release and out of the aggregate CHANGELOG.md, the
// per-version CHANGELOG_LLM.md, and the docs site.
//
// GitHub's release pages do NOT auto-generate heading anchors, so a bare
// `[text](#slug)` link would not resolve. To make the ToC clickable, this script
// injects an explicit HTML anchor (`<a id="slug"></a>`) inline into each heading and
// links the ToC entries to those ids. GitHub renders `<a id>` in release bodies, so
// the in-page links jump correctly.
//
// It indexes the `##` and `###` headings of the notes body (fenced code blocks and any
// pre-existing ToC are skipped). No-op if the body has no such headings.
//
// Usage: node .github/scripts/prepend-release-toc.mjs <notes-file-path>

import { readFileSync, writeFileSync } from 'node:fs'

const TOC_TITLE = 'Table of Contents'
const TOC_HEADING = `## ${TOC_TITLE}`

// Slug for an explicit `<a id>`: lowercase, drop punctuation/emoji (keep letters,
// numbers, spaces, `_`, `-`), then spaces -> hyphens. The id is emitted verbatim, so
// it only needs to be unique and fragment-safe — it does not have to mirror GitHub's
// own algorithm.
function slugify (text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

// Disambiguate repeated slugs with `-1`, `-2`, … in order of appearance.
function makeUniquifier () {
  const seen = new Set()
  return function uniquify (base) {
    const root = base || 'section'
    let slug = root
    let n = 0
    while (seen.has(slug)) {
      n += 1
      slug = `${root}-${n}`
    }
    seen.add(slug)
    return slug
  }
}

// Walk the body once. For every `##`/`###` heading (outside fenced code blocks and not
// the ToC heading itself), assign a unique slug, rewrite the heading line to carry an
// inline `<a id="slug"></a>`, and collect the entry for the ToC. Returns the rewritten
// body lines and the collected entries.
function annotateHeadings (body) {
  const lines = body.split(/\r?\n/)
  const entries = []
  const uniquify = makeUniquifier()
  let fenceMarker = ''
  let firstHeadingIndex = -1

  const out = lines.map((line, i) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1][0]
      if (fenceMarker === '') fenceMarker = marker
      else if (fenceMarker === marker) fenceMarker = ''
      return line
    }
    if (fenceMarker !== '') return line

    const heading = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) return line

    const text = heading[2].trim()
    if (text === TOC_TITLE) return line

    const level = heading[1].length
    const slug = uniquify(slugify(text))
    if (firstHeadingIndex === -1) firstHeadingIndex = i
    entries.push({ level, text, slug })
    return `${heading[1]} <a id="${slug}"></a>${text}`
  })

  return { lines: out, entries, firstHeadingIndex }
}

function renderToc (entries) {
  const out = [TOC_HEADING, '']
  for (const { level, text, slug } of entries) {
    const indent = level === 3 ? '  ' : ''
    out.push(`${indent}- [${text}](#${slug})`)
  }
  return out.join('\n')
}

function main () {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('usage: prepend-release-toc.mjs <notes-file-path>')
    process.exit(1)
  }

  const body = readFileSync(filePath, 'utf8')

  if (body.split(/\r?\n/).some((l) => l.trim() === TOC_HEADING)) {
    console.log('Release notes already contain a Table of Contents; leaving unchanged.')
    return
  }

  const { lines, entries, firstHeadingIndex } = annotateHeadings(body)
  if (entries.length === 0) {
    console.log('No ## / ### headings found; leaving release notes unchanged.')
    return
  }

  // Place the ToC AFTER the summary (the NPM line + intro paragraph that precede the
  // first content section) and immediately BEFORE that first `##`/`###` heading.
  const preamble = lines.slice(0, firstHeadingIndex).join('\n').replace(/^\s+|\s+$/g, '')
  const rest = lines.slice(firstHeadingIndex).join('\n')
  const parts = preamble ? [preamble, renderToc(entries), rest] : [renderToc(entries), rest]

  writeFileSync(filePath, `${parts.join('\n\n').replace(/\n+$/, '')}\n`, 'utf8')
  console.log(`Inserted Table of Contents with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`)
}

main()
