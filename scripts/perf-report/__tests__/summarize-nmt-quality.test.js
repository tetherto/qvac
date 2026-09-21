'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPT_PATH = path.join(__dirname, '..', 'summarize-nmt-quality.js')

const {
  parsePairFromArtifactDir,
  parsePlatformFromArtifactDir,
  parseResultFile,
  collectResults,
  buildRows,
  renderMarkdown
} = require('../summarize-nmt-quality')

test('parsePairFromArtifactDir extracts the leading language pair', () => {
  assert.equal(
    parsePairFromArtifactDir('results-en-it-qvac_bergamot-chrfpp,comet-fast'),
    'en-it')
  assert.equal(
    parsePairFromArtifactDir('results-de-en-qvac_bergamot-chrfpp-fast-pivot'),
    'de-en')
  assert.equal(
    parsePairFromArtifactDir('results-en-it-qvac_bergamot-chrfpp-fast-macos-arm64'),
    'en-it')
  assert.equal(parsePairFromArtifactDir('results-'), null)
})

test('parsePlatformFromArtifactDir extracts a trailing platform id', () => {
  assert.equal(
    parsePlatformFromArtifactDir('results-en-it-qvac_bergamot-chrfpp-fast-linux-x64'),
    'linux-x64')
  assert.equal(
    parsePlatformFromArtifactDir('results-en-it-qvac_bergamot-chrfpp-fast-macos-arm64'),
    'macos-arm64')
  assert.equal(
    parsePlatformFromArtifactDir('results-en-it-qvac_bergamot-chrfpp-fast-windows-x64'),
    'windows-x64')
  assert.equal(
    parsePlatformFromArtifactDir('results-en-it-qvac-chrfpp-fast-linux-x64-gpu'),
    'linux-x64-gpu')
  assert.equal(
    parsePlatformFromArtifactDir('results-en-it-qvac_bergamot-chrfpp-fast'),
    null)
})

test('parseResultFile accepts stat files and rejects hypothesis files', () => {
  assert.deepEqual(
    parseResultFile('flores-devtest.qvac_bergamot.it.chrfpp'),
    { dataset: 'flores-devtest', translator: 'qvac_bergamot', lang: 'it', ext: 'chrfpp' })
  assert.deepEqual(
    parseResultFile('conversational-phrases.bergamot.de.perf'),
    { dataset: 'conversational-phrases', translator: 'bergamot', lang: 'de', ext: 'perf' })
  assert.equal(parseResultFile('flores-devtest.qvac_bergamot.it'), null)
  assert.equal(parseResultFile('flores-devtest.qvac_bergamot.it.log'), null)
})

test('collectResults walks results-* dirs and reads stat values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-summary-'))
  const artifactDir = path.join(dir, 'results-en-it-qvac_bergamot-chrfpp,comet-fast')
  fs.mkdirSync(artifactDir, { recursive: true })
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.3\n')
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.comet'), '84.2\n')
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.time'), '42.17\n')
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.perf'), '512.4\n')
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it'), 'ciao mondo\n')

  const records = collectResults(dir)
  assert.equal(records.length, 4)
  const chrfpp = records.find(r => r.ext === 'chrfpp')
  assert.deepEqual(chrfpp, {
    pair: 'en-it',
    dataset: 'flores-devtest',
    translator: 'qvac_bergamot',
    ext: 'chrfpp',
    value: 55.3,
    device: null,
    platform: null
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('collectResults tags records with the platform artifact suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-summary-'))
  const linuxDir = path.join(dir, 'results-en-it-qvac_bergamot-chrfpp-fast-linux-x64', 'en-it')
  const macDir = path.join(dir, 'results-en-it-qvac_bergamot-chrfpp-fast-macos-arm64', 'en-it')
  fs.mkdirSync(linuxDir, { recursive: true })
  fs.mkdirSync(macDir, { recursive: true })
  fs.writeFileSync(path.join(linuxDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.3\n')
  fs.writeFileSync(path.join(macDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.1\n')

  const records = collectResults(dir)
  assert.equal(records.length, 2)
  assert.equal(records.find(r => r.value === 55.3).platform, 'linux-x64')
  assert.equal(records.find(r => r.value === 55.1).platform, 'macos-arm64')

  const rows = buildRows(records, { device: 'cpu', platforms: ['linux-x64', 'macos-arm64'] })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.platform), ['linux-x64', 'macos-arm64'])

  const md = renderMarkdown(rows, { metrics: ['chrfpp'] })
  assert.match(md, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| 55\.3 \|/)
  assert.match(md, /\| en-it \| qvac_bergamot \| macos-arm64 \| CPU \| flores-devtest \| 55\.1 \|/)
  assert.match(md, /2 platform\(s\): linux-x64, macos-arm64/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('collectResults reads pair directories at either nesting level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-summary-'))
  const flatPairDir = path.join(dir, 'en-it')
  const nestedPairDir = path.join(dir, 'results-en-de-qvac_bergamot-chrfpp-fast', 'en-de')
  fs.mkdirSync(flatPairDir, { recursive: true })
  fs.mkdirSync(nestedPairDir, { recursive: true })
  fs.writeFileSync(path.join(flatPairDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.3\n')
  fs.writeFileSync(path.join(nestedPairDir, 'flores-devtest.qvac_bergamot.de.chrfpp'), '60.1\n')

  const records = collectResults(dir)
  assert.equal(records.length, 2)
  assert.equal(records.find(r => r.pair === 'en-it').value, 55.3)
  assert.equal(records.find(r => r.pair === 'en-de').value, 60.1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('collectResults tags records under a device subdirectory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-summary-'))
  const artifactDir = path.join(dir, 'results-en-it-qvac_bergamot-chrfpp-fast')
  const gpuDir = path.join(artifactDir, 'gpu')
  fs.mkdirSync(gpuDir, { recursive: true })
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.3\n')
  fs.writeFileSync(path.join(gpuDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '56.1\n')

  const records = collectResults(dir)
  assert.equal(records.length, 2)
  assert.equal(records.find(r => r.value === 55.3).device, null)
  assert.equal(records.find(r => r.value === 56.1).device, 'gpu')

  const rows = buildRows(records, { device: 'cpu' })
  assert.equal(rows.length, 2)
  const cpuRow = rows.find(r => r.device === 'cpu')
  const gpuRow = rows.find(r => r.device === 'gpu')
  assert.equal(cpuRow.stats.chrfpp, 55.3)
  assert.equal(gpuRow.stats.chrfpp, 56.1)

  const md = renderMarkdown(rows, { metrics: ['chrfpp'] })
  assert.match(md, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| 55\.3 \|/)
  assert.match(md, /\| en-it \| qvac_bergamot \| linux-x64 \| GPU \| flores-devtest \| 56\.1 \|/)
  assert.ok(!md.includes('GPU rows: none'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildRows seeds N/A rows for expected combos without data', () => {
  const records = [
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'chrfpp', value: 55.3 }
  ]
  const rows = buildRows(records, {
    device: 'cpu',
    pairs: ['en-it', 'en-de'],
    translators: ['qvac_bergamot'],
    datasets: ['flores-devtest']
  })
  assert.equal(rows.length, 2)
  const enDe = rows.find(r => r.pair === 'en-de')
  assert.deepEqual(enDe.stats, {})
  const enIt = rows.find(r => r.pair === 'en-it')
  assert.equal(enIt.stats.chrfpp, 55.3)
  assert.equal(enIt.device, 'cpu')
  assert.equal(enIt.platform, 'linux-x64')
})

test('buildRows seeds N/A rows for every expected platform', () => {
  const records = [
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'chrfpp', value: 55.3, platform: 'macos-arm64' }
  ]
  const rows = buildRows(records, {
    device: 'cpu',
    platforms: ['linux-x64', 'macos-arm64'],
    pairs: ['en-it'],
    translators: ['qvac_bergamot'],
    datasets: ['flores-devtest']
  })
  assert.equal(rows.length, 2)
  const linuxRow = rows.find(r => r.platform === 'linux-x64')
  const macRow = rows.find(r => r.platform === 'macos-arm64')
  assert.deepEqual(linuxRow.stats, {})
  assert.equal(macRow.stats.chrfpp, 55.3)
})

test('renderMarkdown emits one row per model x device with stat columns', () => {
  const rows = buildRows([
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'chrfpp', value: 55.3 },
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'comet', value: 84.2 },
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'time', value: 42.17 },
    { pair: 'en-it', dataset: 'flores-devtest', translator: 'qvac_bergamot', ext: 'perf', value: 512.4 }
  ], {
    device: 'cpu',
    pairs: ['en-it', 'en-de'],
    translators: ['qvac_bergamot'],
    datasets: ['flores-devtest']
  })
  const md = renderMarkdown(rows, { metrics: ['chrfpp', 'comet'] })

  assert.match(md, /## Benchmark Summary — All Models/)
  assert.match(md, /\| Model \| Translator \| Platform \| Device \| Dataset \| chrF\+\+ \| COMET \| Wall Time \(s\) \| Speed \(tok\/s\) \|/)
  assert.match(md, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| 55\.3 \| 84\.2 \| 42\.17 \| 512\.4 \|/)
  assert.match(md, /\| en-de \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| N\/A \| N\/A \| N\/A \| N\/A \|/)
  assert.ok(!md.includes('BLEU'))
  assert.match(md, /1 platform\(s\): linux-x64/)
  assert.match(md, /GPU rows: none/)
  assert.ok(md.endsWith('\n'))
  assert.ok(!md.endsWith('\n\n'))
})

test('renderMarkdown reports when no rows exist at all', () => {
  const md = renderMarkdown([], { metrics: ['chrfpp'] })
  assert.match(md, /No evaluation results found/)
  assert.ok(md.endsWith('\n'))
  assert.ok(!md.endsWith('\n\n'))
})

function runCli (args, cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH].concat(args), { cwd, encoding: 'utf8' })
}

function makeArtifactFixture () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-summary-cli-'))
  const artifactDir = path.join(dir, 'results-en-it-qvac_bergamot-chrfpp-fast')
  fs.mkdirSync(artifactDir, { recursive: true })
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.chrfpp'), '55.3\n')
  fs.writeFileSync(path.join(artifactDir, 'flores-devtest.qvac_bergamot.it.time'), '42.17\n')
  return dir
}

test('cli writes markdown and json output files', () => {
  const dir = makeArtifactFixture()
  const mdPath = path.join(dir, 'out', 'summary.md')
  const jsonPath = path.join(dir, 'out', 'summary.json')
  const proc = runCli([
    '--dir', dir,
    '--pairs', 'en-it,en-de',
    '--translators', 'qvac_bergamot',
    '--datasets', 'flores-devtest',
    '--metrics', 'chrfpp',
    '--output', mdPath,
    '--output-json', jsonPath
  ], dir)

  assert.equal(proc.status, 0)
  const md = fs.readFileSync(mdPath, 'utf8')
  assert.match(md, /## Benchmark Summary — All Models/)
  assert.match(md, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| 55\.3 \| 42\.17 \| N\/A \|/)
  assert.match(md, /\| en-de \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| N\/A \| N\/A \| N\/A \|/)
  assert.ok(md.endsWith('\n'))
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(parsed.rows.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cli prints markdown to stdout without --output', () => {
  const dir = makeArtifactFixture()
  const proc = runCli(['--dir', dir, '--metrics', 'chrfpp'], dir)

  assert.equal(proc.status, 0)
  assert.match(proc.stdout, /## Benchmark Summary — All Models/)
  assert.match(proc.stdout, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \|/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cli seeds rows for every platform passed via --platforms', () => {
  const dir = makeArtifactFixture()
  const proc = runCli([
    '--dir', dir,
    '--pairs', 'en-it',
    '--translators', 'qvac_bergamot',
    '--datasets', 'flores-devtest',
    '--metrics', 'chrfpp',
    '--platforms', 'linux-x64,macos-arm64'
  ], dir)

  assert.equal(proc.status, 0)
  assert.match(proc.stdout, /\| en-it \| qvac_bergamot \| linux-x64 \| CPU \| flores-devtest \| 55\.3 \| 42\.17 \|/)
  assert.match(proc.stdout, /\| en-it \| qvac_bergamot \| macos-arm64 \| CPU \| flores-devtest \| N\/A \| N\/A \|/)
  assert.match(proc.stdout, /2 platform\(s\): linux-x64, macos-arm64/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cli fails with a usage error when --dir is missing', () => {
  const proc = runCli([], os.tmpdir())

  assert.equal(proc.status, 1)
  assert.match(proc.stderr, /--dir is required/)
  assert.match(proc.stdout, /Usage:/)
})

test('cli prints usage and exits 0 on --help', () => {
  const proc = runCli(['--help'], os.tmpdir())

  assert.equal(proc.status, 0)
  assert.match(proc.stdout, /Usage: summarize-nmt-quality\.js --dir <results-dir>/)
})
