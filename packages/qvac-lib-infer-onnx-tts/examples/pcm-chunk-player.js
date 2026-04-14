'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { spawnSync } = require('bare-subprocess')
const { createWav } = require('./wav-helper')

let _seq = 0
let _hasFfplay
let _hasAplay

function syncOk (cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    return (r.status | 0) === 0
  } catch {
    return false
  }
}

function detectFfplay () {
  if (_hasFfplay !== undefined) return _hasFfplay
  _hasFfplay = syncOk('ffplay', ['-hide_banner', '-version'])
  return _hasFfplay
}

function detectAplay () {
  if (_hasAplay !== undefined) return _hasAplay
  _hasAplay = os.platform() === 'linux' && syncOk('aplay', ['--version'])
  return _hasAplay
}

/**
 * Whether this machine is likely able to play 16-bit mono PCM chunks (used by the streaming TTS example).
 */
function canPlayPcmChunks () {
  if (os.platform() === 'darwin') return true
  if (detectFfplay()) return true
  if (detectAplay()) return true
  return false
}

function toInt16Array (samples) {
  if (samples instanceof Int16Array) return samples
  return Int16Array.from(samples)
}

function unlinkQuiet (p) {
  try {
    fs.unlinkSync(p)
  } catch (_) {}
}

/**
 * Plays one chunk of int16 mono PCM at `sampleRate` Hz, blocking until playback finishes (queues naturally if called from sequential callbacks).
 */
function playInt16ChunkSync (samples, sampleRate) {
  const pcm = toInt16Array(samples)
  if (pcm.length === 0) return

  const id = `${Date.now()}-${++_seq}`
  const tmpDir = os.tmpdir()
  const plat = os.platform()

  if (plat === 'darwin') {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(pcm), sampleRate, tmpWav)
    spawnSync('afplay', [tmpWav], { stdio: 'ignore' })
    unlinkQuiet(tmpWav)
    return
  }

  if (detectFfplay()) {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(pcm), sampleRate, tmpWav)
    spawnSync(
      'ffplay',
      ['-nodisp', '-autoexit', '-loglevel', 'error', '-i', tmpWav],
      { stdio: 'ignore' }
    )
    unlinkQuiet(tmpWav)
    return
  }

  if (detectAplay()) {
    const rawPath = path.join(tmpDir, `qvac-tts-stream-${id}.raw`)
    fs.writeFileSync(rawPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    spawnSync(
      'aplay',
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1', rawPath],
      { stdio: 'ignore' }
    )
    unlinkQuiet(rawPath)
  }
}

module.exports = {
  canPlayPcmChunks,
  playInt16ChunkSync
}
