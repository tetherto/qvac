#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const METRIC_EXTENSIONS = ['bleu', 'chrfpp', 'comet']
const STAT_EXTENSIONS = METRIC_EXTENSIONS.concat(['time', 'perf'])
const DEVICE_DIRS = ['cpu', 'gpu']
const PAIR_RE = /^[a-z]{2,3}-[a-z]{2,3}$/
const PLATFORM_RE = /-((?:linux|macos|windows)-(?:x64|arm64)(?:-gpu)?)$/
const DEFAULT_PLATFORM = 'linux-x64'

const METRIC_LABELS = {
  bleu: 'BLEU',
  chrfpp: 'chrF++',
  comet: 'COMET',
  time: 'Wall Time (s)',
  perf: 'Speed (tok/s)'
}

function parseArgs (argv) {
  const args = {
    dir: null,
    pairs: null,
    translators: null,
    datasets: null,
    metrics: null,
    device: 'cpu',
    platforms: null,
    output: null,
    outputJson: null,
    help: false
  }

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dir': args.dir = argv[++i]; break
      case '--pairs': args.pairs = argv[++i]; break
      case '--translators': args.translators = argv[++i]; break
      case '--datasets': args.datasets = argv[++i]; break
      case '--metrics': args.metrics = argv[++i]; break
      case '--device': args.device = argv[++i]; break
      case '--platforms': args.platforms = argv[++i]; break
      case '--output': args.output = argv[++i]; break
      case '--output-json': args.outputJson = argv[++i]; break
      case '--help': case '-h': args.help = true; break
    }
  }
  return args
}

function printHelp () {
  console.log('Usage: summarize-nmt-quality.js --dir <results-dir> ' +
    '[--pairs csv] [--translators csv] [--datasets csv] [--metrics csv] ' +
    '[--device label] [--platforms csv] [--output file] [--output-json file]')
}

function splitCsv (value) {
  if (!value) return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

function parsePairFromArtifactDir (name) {
  const stripped = name.replace(/^results-/, '')
  const tokens = stripped.split('-')
  if (tokens.length < 2 || !tokens[0] || !tokens[1]) return null
  return `${tokens[0]}-${tokens[1]}`
}

function parsePlatformFromArtifactDir (name) {
  const match = PLATFORM_RE.exec(name)
  return match ? match[1] : null
}

function parseResultFile (basename) {
  const parts = basename.split('.')
  if (parts.length !== 4) return null
  const [dataset, translator, lang, ext] = parts
  if (!STAT_EXTENSIONS.includes(ext)) return null
  if (!dataset || !translator || !lang) return null
  return { dataset, translator, lang, ext }
}

function discoverPairRoots (dir) {
  const roots = []
  if (!fs.existsSync(dir)) return roots

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(dir, entry.name)
    if (PAIR_RE.test(entry.name)) {
      roots.push({ pair: entry.name, dir: entryPath, platform: null })
      continue
    }
    if (!entry.name.startsWith('results-')) continue
    const platform = parsePlatformFromArtifactDir(entry.name)
    const pairDirs = fs.readdirSync(entryPath, { withFileTypes: true })
      .filter(child => child.isDirectory() && PAIR_RE.test(child.name))
    if (pairDirs.length) {
      for (const child of pairDirs) {
        roots.push({ pair: child.name, dir: path.join(entryPath, child.name), platform })
      }
      continue
    }
    const pair = parsePairFromArtifactDir(entry.name)
    if (pair) roots.push({ pair, dir: entryPath, platform })
  }
  return roots
}

function collectResults (dir) {
  const records = []
  for (const root of discoverPairRoots(dir)) {
    const pair = root.pair

    const stack = [{ dir: root.dir, device: null }]
    while (stack.length) {
      const current = stack.pop()
      for (const file of fs.readdirSync(current.dir, { withFileTypes: true })) {
        const filePath = path.join(current.dir, file.name)
        if (file.isDirectory()) {
          const name = file.name.toLowerCase()
          stack.push({
            dir: filePath,
            device: DEVICE_DIRS.includes(name) ? name : current.device
          })
          continue
        }
        const parsed = parseResultFile(file.name)
        if (!parsed) continue
        const raw = fs.readFileSync(filePath, 'utf8').trim()
        const value = Number.parseFloat(raw)
        if (!Number.isFinite(value)) continue
        records.push({
          pair,
          dataset: parsed.dataset,
          translator: parsed.translator,
          ext: parsed.ext,
          value,
          device: current.device,
          platform: root.platform
        })
      }
    }
  }
  return records
}

function rowKey (pair, translator, platform, device, dataset) {
  return `${pair}|${translator}|${platform}|${device}|${dataset}`
}

function buildRows (records, { device = 'cpu', platforms = [], pairs = [], translators = [], datasets = [] } = {}) {
  const rows = new Map()
  const seedPlatforms = platforms.length ? platforms : [DEFAULT_PLATFORM]
  const fallbackPlatform = seedPlatforms[0]

  function ensureRow (pair, translator, platform, dev, dataset) {
    const key = rowKey(pair, translator, platform, dev, dataset)
    if (!rows.has(key)) {
      rows.set(key, { pair, translator, platform, device: dev, dataset, stats: {} })
    }
    return rows.get(key)
  }

  for (const pair of pairs) {
    for (const translator of translators) {
      for (const platform of seedPlatforms) {
        for (const dataset of datasets) {
          ensureRow(pair, translator, platform, device, dataset)
        }
      }
    }
  }

  for (const record of records) {
    const row = ensureRow(
      record.pair,
      record.translator,
      record.platform || fallbackPlatform,
      record.device || device,
      record.dataset)
    row.stats[record.ext] = record.value
  }

  return Array.from(rows.values()).sort((a, b) =>
    a.pair.localeCompare(b.pair) ||
    a.translator.localeCompare(b.translator) ||
    a.platform.localeCompare(b.platform) ||
    a.device.localeCompare(b.device) ||
    a.dataset.localeCompare(b.dataset))
}

function formatStat (value, ext) {
  if (value === undefined || value === null) return 'N/A'
  return ext === 'time' ? value.toFixed(2) : value.toFixed(1)
}

function renderMarkdown (rows, { metrics = [] } = {}) {
  const lines = []
  lines.push('## Benchmark Summary — All Models')
  lines.push('')

  if (!rows.length) {
    lines.push('_No evaluation results found — every benchmark lane failed before producing artifacts._')
    lines.push('')
    return lines.join('\n')
  }

  const metricColumns = METRIC_EXTENSIONS.filter(ext =>
    metrics.includes(ext) || rows.some(row => row.stats[ext] !== undefined))
  const columns = metricColumns.concat(['time', 'perf'])

  lines.push('One row per model (language pair) x translator x platform x device; scores per dataset.')
  lines.push('')
  lines.push(`| Model | Translator | Platform | Device | Dataset | ${columns.map(ext => METRIC_LABELS[ext]).join(' | ')} |`)
  lines.push(`|-------|------------|----------|--------|---------|${columns.map(() => '-------:|').join('')}`)

  for (const row of rows) {
    const cells = columns.map(ext => formatStat(row.stats[ext], ext))
    lines.push(`| ${row.pair} | ${row.translator} | ${row.platform} | ${row.device.toUpperCase()} | ${row.dataset} | ${cells.join(' | ')} |`)
  }

  const models = new Set(rows.map(row => row.pair))
  const platforms = Array.from(new Set(rows.map(row => row.platform))).sort()
  const devices = Array.from(new Set(rows.map(row => row.device.toUpperCase()))).sort()
  const missing = rows.filter(row => columns.every(ext => row.stats[ext] === undefined)).length

  lines.push('')
  lines.push('**Coverage:**')
  lines.push(`- Rows: ${rows.length} (${models.size} model(s), ${platforms.length} platform(s): ${platforms.join(', ')}, ${devices.length} device type(s): ${devices.join(', ')})`)
  if (!devices.includes('GPU')) {
    lines.push('- GPU rows: none — this workflow only runs the Bergamot/intgemm CPU lane today; GPU rows will appear here once a GPU evaluation lane exists.')
  }
  if (missing > 0) {
    lines.push(`- ${missing} row(s) have no data (lane failed or produced no artifact).`)
  }
  lines.push('')
  return lines.join('\n')
}

function main () {
  const args = parseArgs(process.argv)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (!args.dir) {
    console.error('Error: --dir is required')
    printHelp()
    process.exit(1)
  }

  const records = collectResults(args.dir)
  console.error(`Collected ${records.length} stat value(s) from ${args.dir}`)

  const rows = buildRows(records, {
    device: args.device,
    platforms: splitCsv(args.platforms),
    pairs: splitCsv(args.pairs),
    translators: splitCsv(args.translators),
    datasets: splitCsv(args.datasets)
  })

  const markdown = renderMarkdown(rows, { metrics: splitCsv(args.metrics) })

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true })
    fs.writeFileSync(args.output, markdown)
    console.error(`Markdown summary written to ${args.output}`)
  } else {
    console.log(markdown)
  }

  if (args.outputJson) {
    fs.mkdirSync(path.dirname(path.resolve(args.outputJson)), { recursive: true })
    fs.writeFileSync(args.outputJson, JSON.stringify({ rows }, null, 2) + '\n')
    console.error(`JSON summary written to ${args.outputJson}`)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  parsePairFromArtifactDir,
  parsePlatformFromArtifactDir,
  parseResultFile,
  collectResults,
  buildRows,
  renderMarkdown
}
