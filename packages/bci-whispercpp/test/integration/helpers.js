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

module.exports = {
  getTestPaths,
  detectPlatform,
  computeWER
}
