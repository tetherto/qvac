'use strict'

const fs = require('fs')
const path = require('path')
const { REPO_ROOT, COPYRIGHT_HOLDER, COPYRIGHT_YEAR, normalizeLicenseId } = require('./config')
const { collator } = require('./utils')

const SEP = '='.repeat(73)

// ---------------------------------------------------------------------------
// Licenses that require special attribution notices
// ---------------------------------------------------------------------------
const REQUIRED_ATTRIBUTIONS = {
  'llama3.2': [
    'Llama 3.2 is licensed under the Llama 3.2 Community License,',
    'Copyright (c) Meta Platforms, Inc. All Rights Reserved.',
    '',
    'Additional requirements per license Section 1.b.i:',
    '  Products or services distributing or containing Llama 3.2 materials',
    '  must prominently display "Built with Llama" on a related website,',
    '  user interface, blog post, about page, or product documentation.'
  ],
  'qwen-research': [
    'Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT,',
    'Copyright (c) Alibaba Cloud. All Rights Reserved.',
    '',
    'Note: The Qwen Research License permits non-commercial use only.',
    'Commercial use requires a separate license from Alibaba Cloud.'
  ],
  gemma: [
    'Gemma is provided under and subject to the Gemma Terms of Use found',
    'at ai.google.dev/gemma/terms',
    '',
    'Additional requirements per Section 3.1:',
    '  Distribution must be accompanied by the Gemma Terms of Use.',
    '  Use is subject to the Gemma Prohibited Use Policy at',
    '  ai.google.dev/gemma/prohibited_use_policy'
  ],
  'health-ai-developer-foundations': [
    'HAI-DEF is provided under and subject to the Health AI Developer',
    'Foundations Terms of Use found at',
    'https://developers.google.com/health-ai-developer-foundations/terms',
    '',
    'Additional requirements per Section 3.1:',
    '  Distribution must be accompanied by the HAI-DEF Terms of Use.',
    '  Clinical use requires Health Regulatory Authorization from the',
    '  relevant authority (Section 3.1.3).',
    '  Use is subject to the HAI-DEF Prohibited Use Policy at',
    '  developers.google.com/health-ai-developer-foundations/prohibited-use-policy'
  ],
  'openrail++': [
    '# Model Use Restrictions (Open RAIL++-M)',
    '',
    'As a user of the QVAC SDK and its associated model registry, you agree not to use the Model or its Derivatives:',
    '',
    '1. **Illegal Acts:** In any way that violates any applicable national, federal, state, local or international law or regulation.',
    '2. **Harm to Minors:** For the purpose of exploiting, harming or attempting to exploit or harm minors in any way.',
    '3. **Malicious Content:** To generate or disseminate verifiably false information and/or content with the purpose of harming others.',
    '4. **Personal Data:** To generate or disseminate personal identifiable information that can be used to harm an individual.',
    '5. **Defamation & Harassment:** To defame, disparage or otherwise harass others.',
    '6. **Automated Decisions:** For fully automated decision making that adversely impacts an individual\'s legal rights or otherwise creates or modifies a binding, enforceable obligation.',
    '7. **Discrimination:** For any use intended to or which has the effect of discriminating against or harming individuals or groups based on online or offline social behavior or known or predicted personal or personality characteristics.',
    '8. **Exploitation:** To exploit any of the vulnerabilities of a specific group of persons based on their age, social, physical or mental characteristics, in order to materially distort the behavior of a person pertaining to such group in a manner that causes or is likely to cause that person or another person physical or psychological harm.',
    '9. **Medical Advice:** To provide medical advice and medical results interpretation.',
    '10. **Justice & Law Enforcement:** To generate or disseminate information for use by administration of justice, law enforcement, immigration or asylum processes, such as predicting an individual will commit fraud/crime commitment (e.g. by text profiling, drawing causal relationships between assertions made in documents, indiscriminate and untargeted scraping).',
    '',
    '---',
    '*Note: These restrictions must be included in any distribution of the Model or Derivatives thereof to your end-users.*',    
  ]
}

// Friendly display names keyed by NORMALIZED canonical id (from config.normalizeLicenseId)
const LICENSE_DISPLAY_NAMES = {
  'apache-2.0': 'Apache License 2.0',
  'mit': 'MIT License',
  'mpl-2.0': 'Mozilla Public License 2.0',
  'bsd-2-clause': 'BSD 2-Clause License',
  'bsd-3-clause': 'BSD 3-Clause License',
  'isc': 'ISC License',
  '0bsd': 'Zero-Clause BSD',
  'cc-by-4.0': 'Creative Commons Attribution 4.0 International',
  'cc0-1.0': 'Creative Commons Zero 1.0',
  'cc-by-nc-4.0': 'Creative Commons NonCommercial 4.0',
  'cc-by-nc-sa-4.0': 'Creative Commons NonCommercial ShareAlike 4.0',
  'gpl-2.0': 'GNU General Public License v2.0',
  'gpl-2.0-or-later': 'GNU General Public License v2.0 or later',
  'gpl-3.0': 'GNU General Public License v3.0',
  'gpl-3.0-or-later': 'GNU General Public License v3.0 or later',
  'lgpl-2.1': 'GNU Lesser General Public License v2.1',
  'lgpl-3.0': 'GNU Lesser General Public License v3.0',
  'agpl-3.0': 'GNU Affero General Public License v3.0',
  'unlicense': 'The Unlicense',
  'zlib': 'zlib License',
  'python-2.0': 'Python Software Foundation License',
  'llama3.2': 'Llama 3.2 Community License',
  'gemma': 'Gemma Terms of Use',
  'qwen-research': 'Qwen Research License',
  'health-ai-developer-foundations': 'HAI-DEF Terms of Use'
}

function licenseFriendlyName (normalizedKey) {
  if (!normalizedKey || normalizedKey === 'unknown') return 'Unknown'
  const display = LICENSE_DISPLAY_NAMES[normalizedKey]
  return display ? `${normalizedKey} (${display})` : normalizedKey
}

// Use shared normalization from config for grouping
function licenseGroupKey (license) {
  return normalizeLicenseId(license)
}

// ---------------------------------------------------------------------------
// Generic: group items by license, produce sorted blocks
// ---------------------------------------------------------------------------
function buildGroupedByLicense (title, items, formatEntryFn, opts = {}) {
  if (!items || items.length === 0) return null

  const groups = new Map()
  for (const item of items) {
    const key = licenseGroupKey(item.license)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => collator.compare(a, b))
  const lines = []

  // Required Attribution Notices (only for models)
  if (opts.withAttributions) {
    const attribs = []
    for (const key of sortedKeys) {
      if (REQUIRED_ATTRIBUTIONS[key]) {
        attribs.push(...REQUIRED_ATTRIBUTIONS[key], '')
      }
    }
    if (attribs.length > 0) {
      lines.push(SEP)
      lines.push('Required Attribution Notices')
      lines.push(SEP)
      lines.push('')
      lines.push(...attribs)
    }
  }

  lines.push(SEP)
  lines.push(title)
  lines.push(SEP)
  lines.push('')

  for (const key of sortedKeys) {
    const entries = groups.get(key).sort((a, b) => collator.compare(
      a.sortKey || a.name, b.sortKey || b.name
    ))
    const displayLicense = licenseFriendlyName(key)

    lines.push(`--- ${displayLicense} ---`)
    lines.push('')
    for (const entry of entries) {
      lines.push(formatEntryFn(entry))
    }
    lines.push('')
  }

  // Modification Notice (only for models)
  if (opts.withModificationNotice) {
    lines.push(SEP)
    lines.push('Modification Notice')
    lines.push(SEP)
    lines.push('')
    lines.push('Models listed above may have been converted from original model')
    lines.push('weights into optimized inference formats (GGUF, GGML, ONNX, or')
    lines.push('Bergamot intgemm). These conversions involve format transformation')
    lines.push('and/or weight quantization. No architectural changes were made to')
    lines.push('the underlying models.')
    lines.push('')
    lines.push('Source URLs for original weights are recorded in each model\'s')
    lines.push('metadata entry within the registry.')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry formatters
// ---------------------------------------------------------------------------
function formatModelEntry (entry) {
  const lines = [`  ${entry.name}`]
  if (entry.url) lines.push(`    ${entry.url}`)
  return lines.join('\n')
}

function formatJsEntry (entry) {
  const lines = [`  ${entry.name}@${entry.version}`]
  if (entry.url) lines.push(`    ${entry.url}`)
  return lines.join('\n')
}

function formatPythonEntry (entry) {
  const lines = [`  ${entry.name}`]
  if (entry.url) lines.push(`    ${entry.url}`)
  return lines.join('\n')
}

function formatCppEntry (entry) {
  const lines = [`  ${entry.name}`]
  if (entry.url) lines.push(`    ${entry.url}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build the full body of a NOTICE (all sections)
// ---------------------------------------------------------------------------
function buildSections (scanResult) {
  const parts = []

  const modelsBlock = buildGroupedByLicense(
    'Third-Party Model Licenses', scanResult.models, formatModelEntry,
    { withAttributions: true, withModificationNotice: true }
  )
  if (modelsBlock) parts.push(modelsBlock)

  const jsBlock = buildGroupedByLicense(
    'JavaScript Dependencies', scanResult.js, formatJsEntry
  )
  if (jsBlock) parts.push(jsBlock)

  const pyBlock = buildGroupedByLicense(
    'Python Dependencies', scanResult.python, formatPythonEntry
  )
  if (pyBlock) parts.push(pyBlock)

  const cppBlock = buildGroupedByLicense(
    'C++ Dependencies', scanResult.cpp, formatCppEntry
  )
  if (cppBlock) parts.push(cppBlock)

  return parts.length > 0 ? parts.join('\n\n') : ''
}

// ---------------------------------------------------------------------------
// Build full NOTICE content for a package
// ---------------------------------------------------------------------------
function buildPackageNoticeContent (pkgEntry, scanResult) {
  const displayName = pkgEntry.npmName
  const sections = buildSections(scanResult)
  const holder = COPYRIGHT_HOLDER.endsWith('.') ? COPYRIGHT_HOLDER : COPYRIGHT_HOLDER + '.'

  const lines = [
    displayName,
    `Copyright ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`,
    ''
  ]

  if (sections) {
    lines.push(`This product includes third-party components under their`)
    lines.push(`respective licenses. ${displayName} itself is licensed under`)
    lines.push(`Apache-2.0; bundled dependencies are governed by the licenses`)
    lines.push(`listed below.`)
    lines.push('')
    lines.push(sections)
  } else {
    lines.push(`This product includes software developed by ${holder}`)
  }

  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Write per-package NOTICE file
// ---------------------------------------------------------------------------
function writePackageNotice (pkgEntry, scanResult, opts = {}) {
  const content = buildPackageNoticeContent(pkgEntry, scanResult)
  const noticePath = path.join(pkgEntry.fullDir, 'NOTICE')

  if (opts.dryRun) {
    console.log(`\n${'~'.repeat(73)}`)
    console.log(`[dry-run] ${noticePath}`)
    console.log('~'.repeat(73))
    console.log(content)
    return
  }

  fs.writeFileSync(noticePath, content)
  console.log(`  Wrote ${noticePath}`)
}

// ---------------------------------------------------------------------------
// Build full report content (aggregated across all packages, for review)
// Only generated on --all. Gitignored — not shipped with packages.
// ---------------------------------------------------------------------------
function buildFullReportContent (allResults) {
  const sorted = [...allResults].sort(
    (a, b) => collator.compare(a.pkgEntry.npmName, b.pkgEntry.npmName)
  )

  const lines = [
    'QVAC — Full NOTICE Report',
    `Generated: ${new Date().toISOString()}`,
    `Copyright ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`,
    '',
    'This file aggregates all per-package NOTICE data for review.',
    'It is gitignored and NOT shipped with packages.',
    'The authoritative NOTICE files live inside each package directory.',
    ''
  ]

  // ---- License overview: count deps by normalized license per package ----
  lines.push(SEP)
  lines.push('License Overview')
  lines.push(SEP)
  lines.push('')

  const globalCounts = {}
  let globalTotal = 0
  const perPkgSummaries = []

  for (const { pkgEntry, scanResult } of sorted) {
    const pkgCounts = {}
    const allDeps = [
      ...scanResult.models.map(d => ({ license: d.license, type: 'model' })),
      ...scanResult.js.map(d => ({ license: d.license, type: 'js' })),
      ...scanResult.python.map(d => ({ license: d.license, type: 'python' })),
      ...scanResult.cpp.map(d => ({ license: d.license, type: 'cpp' }))
    ]
    if (allDeps.length === 0) continue

    for (const dep of allDeps) {
      const key = licenseGroupKey(dep.license)
      pkgCounts[key] = (pkgCounts[key] || 0) + 1
      globalCounts[key] = (globalCounts[key] || 0) + 1
      globalTotal++
    }

    const typeCounts = { model: 0, js: 0, python: 0, cpp: 0 }
    for (const dep of allDeps) typeCounts[dep.type]++

    perPkgSummaries.push({ pkgEntry, pkgCounts, typeCounts, total: allDeps.length })
  }

  // Global totals
  lines.push(`Total packages: ${sorted.length}`)
  lines.push(`Total dependencies: ${globalTotal}`)
  lines.push('')

  const sortedGlobal = Object.entries(globalCounts)
    .sort((a, b) => b[1] - a[1])

  const maxLicLen = Math.max(...sortedGlobal.map(([l]) => l.length))
  const maxCountLen = String(globalTotal).length

  for (const [license, count] of sortedGlobal) {
    const pct = ((count / globalTotal) * 100).toFixed(1)
    lines.push(
      `  ${license.padEnd(maxLicLen)}  ${String(count).padStart(maxCountLen)} deps  (${pct}%)`
    )
  }
  lines.push('')

  // Per-package breakdown
  for (const { pkgEntry, pkgCounts, typeCounts, total } of perPkgSummaries) {
    lines.push(`--- ${pkgEntry.npmName} (packages/${pkgEntry.dir}) ---`)
    lines.push('')

    const parts = []
    if (typeCounts.model) parts.push(`${typeCounts.model} models`)
    if (typeCounts.js) parts.push(`${typeCounts.js} JS`)
    if (typeCounts.python) parts.push(`${typeCounts.python} Python`)
    if (typeCounts.cpp) parts.push(`${typeCounts.cpp} C++`)
    lines.push(`  Total: ${total} (${parts.join(', ')})`)

    const sortedPkg = Object.entries(pkgCounts).sort((a, b) => b[1] - a[1])
    for (const [license, count] of sortedPkg) {
      lines.push(`    ${license.padEnd(maxLicLen)}  ${count}`)
    }
    lines.push('')
  }

  // ---- Per-package full NOTICE sections ----
  let packagesWithDeps = 0
  for (const { pkgEntry, scanResult } of sorted) {
    const sections = buildSections(scanResult)
    if (!sections) continue
    packagesWithDeps++

    lines.push('')
    lines.push('#'.repeat(73))
    lines.push(`# Package: ${pkgEntry.npmName}`)
    lines.push(`# Directory: packages/${pkgEntry.dir}`)
    lines.push('#'.repeat(73))
    lines.push('')
    lines.push(sections)
    lines.push('')
  }

  return { content: lines.join('\n'), count: packagesWithDeps }
}

// ---------------------------------------------------------------------------
// Write NOTICE_FULL_REPORT.txt (only on --all, gitignored)
// ---------------------------------------------------------------------------
function writeFullReport (allResults, opts = {}) {
  const { content, count } = buildFullReportContent(allResults)
  const reportPath = path.join(REPO_ROOT, 'NOTICE_FULL_REPORT.txt')

  if (opts.dryRun) {
    console.log(`\n${'~'.repeat(73)}`)
    console.log(`[dry-run] ${reportPath} (${count} packages with deps)`)
    console.log('~'.repeat(73))
    console.log(content)
    return
  }

  fs.writeFileSync(reportPath, content)
  console.log(`  Wrote NOTICE_FULL_REPORT.txt (${count} packages with deps)`)
}

// ---------------------------------------------------------------------------
// Write NOTICE_LOG.txt
// ---------------------------------------------------------------------------
function writeNoticeLog (logEntries, opts = {}) {
  const logPath = path.join(REPO_ROOT, 'NOTICE_LOG.txt')

  let content
  if (logEntries.length === 0) {
    content = `[${new Date().toISOString()}] NOTICE generation completed with no errors.\n`
  } else {
    const header = `[${new Date().toISOString()}] NOTICE generation completed with ${logEntries.length} warning(s)/error(s):\n\n`
    content = header + logEntries.join('\n') + '\n'
  }

  if (opts.dryRun) {
    console.log(`\n  [dry-run] Would write NOTICE_LOG.txt (${logEntries.length} entries)`)
    return
  }

  fs.writeFileSync(logPath, content)
  console.log(`  Wrote NOTICE_LOG.txt (${logEntries.length} entries)`)
}

module.exports = {
  buildSections,
  writePackageNotice,
  writeNoticeLog
}
