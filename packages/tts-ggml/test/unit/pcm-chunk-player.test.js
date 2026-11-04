'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { pathToFileURL } = require('bare-url')

const EXAMPLES_DIR = path.join(__dirname, '..', '..', 'examples')
const PLAYER_FILE = 'pcm-chunk-player.js'
const PLAYER_SOURCES = [PLAYER_FILE, 'wav-helper.js']
const PLAYER_RUNTIME_MODULES = ['bare-fs', 'bare-os', 'bare-path']
const UNRESOLVABLE_SUBPROCESS = './bare-subprocess-is-not-installed.js'
const INSTALL_HINT = 'npm install bare-subprocess'
const SAMPLE_RATE = 24000
const SAMPLES = [1, 2, 3]

function copyPlayerSources(dir) {
  PLAYER_SOURCES.forEach((file) => {
    fs.copyFileSync(path.join(EXAMPLES_DIR, file), path.join(dir, file))
  })
}

function resolveFromExamples(name) {
  const referrer = pathToFileURL(path.join(EXAMPLES_DIR, PLAYER_FILE))
  return pathToFileURL(require.resolve(name, { referrer })).href
}

function importsWithoutSubprocess() {
  const imports = { 'bare-subprocess': UNRESOLVABLE_SUBPROCESS }
  PLAYER_RUNTIME_MODULES.forEach((name) => {
    imports[name] = resolveFromExamples(name)
  })
  return imports
}

function writeImportMap(dir) {
  const manifest = {
    name: 'pcm-chunk-player-probe',
    private: true,
    imports: importsWithoutSubprocess()
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
}

function loadPlayerWithoutSubprocess(dir) {
  copyPlayerSources(dir)
  writeImportMap(dir)
  return require(path.join(dir, PLAYER_FILE))
}

function captureWarnings(t) {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(message)
  t.teardown(() => {
    console.warn = originalWarn
  })
  return warnings
}

test('pcm-chunk-player skips playback when bare-subprocess is not installed', async (t) => {
  const dir = await t.tmp()
  const warnings = captureWarnings(t)
  const player = loadPlayerWithoutSubprocess(dir)

  t.is(player.canPlayPcmChunks(), false)
  t.is(player.createStreamingPlayer({ sampleRate: SAMPLE_RATE }), null)
  t.is(player.playInt16ChunkSync(SAMPLES, SAMPLE_RATE), undefined)
  t.is(await player.playInt16Chunk(SAMPLES, SAMPLE_RATE), undefined)
  t.is(warnings.length, 1, 'the missing module is reported once')
  t.ok(warnings[0].includes(INSTALL_HINT))
})
