'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function configure(root) {
  const helper = path.resolve(__dirname, '../../cmake/TtsHexagon.cmake').replaceAll('\\', '/')
  fs.writeFileSync(
    path.join(root, 'CMakeLists.txt'),
    `cmake_minimum_required(VERSION 3.25)
project(test NONE)
include("${helper}")
tts_stage_hexagon_assets("\${CMAKE_SOURCE_DIR}/libs" "android-arm64/addon")
`
  )
  return spawnSync('cmake', ['-S', root, '-B', path.join(root, 'build')], { encoding: 'utf8' })
}

test('Hexagon assets preserve every DSP architecture and exclude unrelated host libraries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hexagon-'))
  try {
    fs.mkdirSync(path.join(root, 'libs'))
    const files = [
      'libggml-htp-v73.so',
      'libggml-htp-v75.so',
      'libggml-htp-v79.so',
      'libggml-htp-v81.so'
    ]
    for (const file of [...files, 'libunrelated.so'])
      fs.writeFileSync(path.join(root, 'libs', file), file)
    const result = configure(root)
    assert.equal(result.status, 0, result.stderr)
    const prefix = path.join(root, 'installed')
    const install = spawnSync(
      'cmake',
      ['--install', path.join(root, 'build'), '--prefix', prefix],
      { encoding: 'utf8' }
    )
    assert.equal(install.status, 0, install.stderr)
    const destination = path.join(prefix, 'android-arm64/addon')
    assert.deepEqual(fs.readdirSync(destination).sort(), files.sort())
    for (const file of files)
      assert.equal(fs.readFileSync(path.join(destination, file), 'utf8'), file)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Hexagon configuration fails instead of shipping a build without DSP skeletons', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hexagon-missing-'))
  try {
    fs.mkdirSync(path.join(root, 'libs'))
    const result = configure(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires the matching installed DSP skeletons/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
