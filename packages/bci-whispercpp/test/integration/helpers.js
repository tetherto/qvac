'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { computeWER } = require('../../lib/wer')

function getTestPaths () {
  const fixturesDir = path.join(__dirname, '..', 'fixtures')
  const manifestPath = path.join(fixturesDir, 'manifest.json')

  let manifest = { samples: [] }
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  }

  return {
    fixturesDir,
    manifest,
    getSamplePath: (filename) => path.join(fixturesDir, filename)
  }
}

function detectPlatform () {
  const os = require('bare-os')
  const arch = os.arch()
  const platform = os.platform()
  return { arch, platform, label: `${platform}-${arch}` }
}

/**
 * Read a .bin neural signal fixture from disk as a Uint8Array view over
 * the original buffer bytes (no copy).
 */
function readSignal (samplePath) {
  const buf = fs.readFileSync(samplePath)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * Parse the [T, C] header of a neural signal buffer and return the header
 * fields alongside a view over the body bytes.
 */
function splitHeaderAndBody (signalBytes) {
  const view = new DataView(signalBytes.buffer, signalBytes.byteOffset, signalBytes.byteLength)
  const timesteps = view.getUint32(0, true)
  const channels = view.getUint32(4, true)
  const body = signalBytes.subarray(8)
  return { timesteps, channels, body }
}

/**
 * Build a fresh [T, C]-prefixed signal buffer from one or more body
 * fragments; used to synthesise longer fixtures (e.g. tile a fixture
 * body N times to force multi-window streaming).
 */
function buildSignal (channels, bodies) {
  const totalBodyBytes = bodies.reduce((sum, b) => sum + b.byteLength, 0)
  const totalTimesteps = totalBodyBytes / (channels * 4)
  const out = new Uint8Array(8 + totalBodyBytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, totalTimesteps, true)
  view.setUint32(4, channels, true)
  let offset = 8
  for (const b of bodies) {
    out.set(b, offset)
    offset += b.byteLength
  }
  return out
}

/**
 * Async generator that yields fixed-size slices of a Uint8Array; used by
 * streaming tests to simulate chunked input delivery.
 */
async function * chunkify (bytes, chunkSize) {
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
  }
}

module.exports = {
  getTestPaths,
  detectPlatform,
  computeWER,
  readSignal,
  splitHeaderAndBody,
  buildSignal,
  chunkify
}
