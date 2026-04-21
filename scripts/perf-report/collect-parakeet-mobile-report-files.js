'use strict'

const fs = require('fs')
const path = require('path')

function walk (dir) {
  const files = []
  if (!fs.existsSync(dir)) return files

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else {
      files.push(fullPath)
    }
  }

  return files
}

function sanitizeName (value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function humanizeLabel (value) {
  return String(value || 'unknown')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferDeviceLabel (relativePath) {
  const baseName = path.basename(relativePath, path.extname(relativePath))
  const prefix = baseName.split(/_(?:job|Tests_Suite|Setup_Suite|Teardown_Suite)_/)[0]
  const trimmed = prefix.replace(/^(?:Manual|PR)-[^-]+-(?:Android|iOS)-?/, '')
  return humanizeLabel(trimmed || prefix)
}

function enrichReport (report, relativePath, platformName) {
  const labels = report.labels || {}
  const requested = report.requested || {}

  const enriched = { ...report }
  enriched.sourceFile = report.sourceFile || relativePath.replace(/\\/g, '/')
  enriched.modelType = report.modelType || (report.model && report.model.type) || 'unknown'
  enriched.useGPU = report.useGPU !== undefined ? report.useGPU : Boolean(requested.useGPU)
  enriched.backendHint = report.backendHint || labels.backend || requested.backendHint || ''
  enriched.deviceLabel = report.deviceLabel || labels.device || inferDeviceLabel(relativePath)
  enriched.runnerLabel = report.runnerLabel || labels.runner || inferDeviceLabel(relativePath)
  enriched.deviceFarmPlatform = report.deviceFarmPlatform || platformName.toLowerCase()
  enriched.platformName = report.platformName || platformName.toLowerCase()

  return enriched
}

function main () {
  const inputDir = process.argv[2]
  const outputDir = process.argv[3]
  const platformName = process.argv[4]

  if (!inputDir || !outputDir || !platformName) {
    console.error('Usage: node scripts/perf-report/collect-parakeet-mobile-report-files.js <input-dir> <output-dir> <platform>')
    process.exit(1)
  }

  const files = walk(inputDir).filter(file => /^perf-report(?:-.*)?\.json$/.test(path.basename(file)))

  fs.mkdirSync(outputDir, { recursive: true })

  let copied = 0
  for (const filePath of files) {
    const relativePath = path.relative(inputDir, filePath)
    try {
      const report = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const enriched = enrichReport(report, relativePath, platformName)
      const fileName = sanitizeName(relativePath.replace(/[\\/]+/g, '-')) + '.json'
      const outputPath = path.join(outputDir, fileName)
      fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2) + '\n', 'utf8')
      copied++
      console.log(`Collected ${outputPath}`)
    } catch (error) {
      console.error(`Failed to collect ${filePath}: ${error.message}`)
    }
  }

  console.log(`Collected ${copied} raw mobile perf report file(s).`)
}

main()
