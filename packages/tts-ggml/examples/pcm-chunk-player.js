'use strict'

/**
 * Streaming audio player for raw int16 PCM chunks.
 *
 * Spawns a single long-running child process that reads raw `s16le` PCM
 * @ 24 kHz mono from stdin and plays it to the default output.  Chunks
 * are written to the process's stdin as they arrive, so there are no
 * per-chunk startup gaps — playback is continuous across the whole
 * synthesis.
 *
 * Contrast with the older per-chunk-afplay approach, which writes each
 * chunk to a tmp wav, spawns `afplay`, waits for it to exit, deletes
 * the wav, repeat: that path adds ~150-300 ms of dead air between every
 * chunk and is unusable for sub-second chunks (breaks words mid-stream).
 *
 * Supported backends (picked in this order):
 *   1. `ffplay`   (ffmpeg, any platform)   — `-f s16le -i -`
 *   2. `play`     (sox, any platform)      — `-t raw -r 24000 ...`
 *   3. `aplay`    (Linux ALSA)             — `-t raw -f S16_LE ...`
 *   4. Per-chunk `afplay` fallback (macOS only; has the gap problem)
 *
 * Old per-chunk helpers (`playInt16Chunk`, `playInt16ChunkSync`) are
 * kept for back-compat but should not be used for native sub-second
 * streaming.
 */

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { spawn, spawnSync } = require('bare-subprocess')
const { createWav } = require('./wav-helper')

let _seq = 0
let _hasFfplay
let _hasPlay
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

function detectPlay () {
  if (_hasPlay !== undefined) return _hasPlay
  _hasPlay = syncOk('play', ['--version'])
  return _hasPlay
}

function detectAplay () {
  if (_hasAplay !== undefined) return _hasAplay
  _hasAplay = os.platform() === 'linux' && syncOk('aplay', ['--version'])
  return _hasAplay
}

function canPlayPcmChunks () {
  if (detectFfplay()) return true
  if (detectPlay()) return true
  if (detectAplay()) return true
  if (os.platform() === 'darwin') return true
  return false
}

function toInt16Buffer (samples) {
  const arr = samples instanceof Int16Array
    ? samples
    : Int16Array.from(samples)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function unlinkQuiet (p) {
  try {
    fs.unlinkSync(p)
  } catch (_) {}
}

function spawnAsync (cmd, args, opts) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, args, opts)
      child.on('exit', (code) => resolve(code))
      child.on('error', reject)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Open a streaming player pipe.  Returns `{ write(samples), end() }`.
 * `write` buffers the chunk and passes it to the player immediately;
 * `end` closes stdin and resolves after the player has drained and
 * exited, so `await player.end()` guarantees every chunk has finished
 * playing before it returns.
 *
 * `sampleRate` defaults to 24000 (Chatterbox native rate).
 */
function createStreamingPlayer ({ sampleRate = 24000, channels = 1 } = {}) {
  // sox `play` is preferred on darwin: on some macOS builds ffplay's
  // SDL output is silent for raw-piped audio; sox uses CoreAudio
  // directly and works reliably.  (qvac-tts.cpp's README documents
  // the same caveat for its `--out -` CLI mode.)
  const preferSox = os.platform() === 'darwin'
  const order = preferSox
    ? [trySox, tryFfplay, tryAplay]
    : [tryFfplay, trySox, tryAplay]
  for (const build of order) {
    const p = build(sampleRate, channels)
    if (p) return p
  }
  if (os.platform() === 'darwin') return createAfplayFallback(sampleRate)
  return null
}

function trySox (sampleRate, channels) {
  if (!detectPlay()) return null
  const args = [
    '-q',
    '-t', 'raw',
    '-r', String(sampleRate),
    '-b', '16',
    '-e', 'signed',
    '-c', String(channels),
    '-'
  ]
  return spawnStreamingPlayer('play', args)
}

function tryFfplay (sampleRate, channels) {
  if (!detectFfplay()) return null
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nodisp',
    '-autoexit',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'pipe:0'
  ]
  return spawnStreamingPlayer('ffplay', args)
}

function tryAplay (sampleRate, channels) {
  if (!detectAplay()) return null
  const args = [
    '-q',
    '-t', 'raw',
    '-f', 'S16_LE',
    '-r', String(sampleRate),
    '-c', String(channels)
  ]
  return spawnStreamingPlayer('aplay', args)
}

function spawnStreamingPlayer (cmd, args) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let exited = false
  let exitResolve
  const exitPromise = new Promise((resolve) => { exitResolve = resolve })
  child.on('exit', () => {
    exited = true
    exitResolve()
  })
  child.on('error', () => {
    exited = true
    exitResolve()
  })
  return {
    backend: cmd,
    write (samples) {
      if (exited) return
      const buf = toInt16Buffer(samples)
      if (buf.length === 0) return
      try {
        child.stdin.write(buf)
      } catch (_) {
        // stdin may be closed if the player died early; swallow.
      }
    },
    async end () {
      try {
        child.stdin.end()
      } catch (_) {}
      await exitPromise
    }
  }
}

/**
 * macOS-only fallback: one afplay per chunk.  Keeps the last audio
 * working when neither ffplay/sox/aplay is installed, but has
 * per-chunk gaps (~150-300 ms) that break sub-second streaming.  A
 * one-time warning is printed the first time it's used.
 */
let _afplayWarned = false
function createAfplayFallback (sampleRate) {
  if (!_afplayWarned) {
    console.warn(
      '[pcm-chunk-player] No ffplay/sox/aplay found; falling back to per-chunk afplay. ' +
      'Install ffmpeg or sox for gapless streaming playback: `brew install ffmpeg` or `brew install sox`.'
    )
    _afplayWarned = true
  }
  const queue = []
  let draining = false
  let endResolve
  const donePromise = new Promise((resolve) => { endResolve = resolve })
  let ended = false

  async function drain () {
    if (draining) return
    draining = true
    while (queue.length > 0) {
      const samples = queue.shift()
      const id = `${Date.now()}-${++_seq}`
      const tmpWav = path.join(os.tmpdir(), `qvac-tts-stream-${id}.wav`)
      createWav(Array.from(samples), sampleRate, tmpWav)
      await spawnAsync('afplay', [tmpWav], { stdio: 'ignore' })
      unlinkQuiet(tmpWav)
    }
    draining = false
    if (ended) endResolve()
  }

  return {
    backend: 'afplay (per-chunk fallback)',
    write (samples) {
      const arr = samples instanceof Int16Array ? samples : Int16Array.from(samples)
      if (arr.length === 0) return
      queue.push(arr)
      drain()
    },
    async end () {
      ended = true
      if (!draining && queue.length === 0) endResolve()
      await donePromise
    }
  }
}

// ---------------------------------------------------------------------
// Legacy per-chunk helpers (kept for back-compat with older examples).
// ---------------------------------------------------------------------

function playInt16ChunkSync (samples, sampleRate) {
  const arr = samples instanceof Int16Array ? samples : Int16Array.from(samples)
  if (arr.length === 0) return

  const id = `${Date.now()}-${++_seq}`
  const tmpDir = os.tmpdir()
  const plat = os.platform()

  if (plat === 'darwin') {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(arr), sampleRate, tmpWav)
    spawnSync('afplay', [tmpWav], { stdio: 'ignore' })
    unlinkQuiet(tmpWav)
    return
  }
  if (detectFfplay()) {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(arr), sampleRate, tmpWav)
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
    fs.writeFileSync(rawPath, toInt16Buffer(arr))
    spawnSync(
      'aplay',
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1', rawPath],
      { stdio: 'ignore' }
    )
    unlinkQuiet(rawPath)
  }
}

async function playInt16Chunk (samples, sampleRate) {
  const arr = samples instanceof Int16Array ? samples : Int16Array.from(samples)
  if (arr.length === 0) return

  const id = `${Date.now()}-${++_seq}`
  const tmpDir = os.tmpdir()
  const plat = os.platform()

  if (plat === 'darwin') {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(arr), sampleRate, tmpWav)
    await spawnAsync('afplay', [tmpWav], { stdio: 'ignore' })
    unlinkQuiet(tmpWav)
    return
  }
  if (detectFfplay()) {
    const tmpWav = path.join(tmpDir, `qvac-tts-stream-${id}.wav`)
    createWav(Array.from(arr), sampleRate, tmpWav)
    await spawnAsync(
      'ffplay',
      ['-nodisp', '-autoexit', '-loglevel', 'error', '-i', tmpWav],
      { stdio: 'ignore' }
    )
    unlinkQuiet(tmpWav)
    return
  }
  if (detectAplay()) {
    const rawPath = path.join(tmpDir, `qvac-tts-stream-${id}.raw`)
    fs.writeFileSync(rawPath, toInt16Buffer(arr))
    await spawnAsync(
      'aplay',
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1', rawPath],
      { stdio: 'ignore' }
    )
    unlinkQuiet(rawPath)
  }
}

function createChunkQueue () {
  const queue = []
  let waiter = null
  let done = false

  function push (item) {
    queue.push(item)
    if (waiter) {
      waiter()
      waiter = null
    }
  }

  function end () {
    done = true
    if (waiter) {
      waiter()
      waiter = null
    }
  }

  async function * drain () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()
        continue
      }
      if (done) return
      await new Promise((resolve) => { waiter = resolve })
    }
  }

  return { push, end, drain }
}

module.exports = {
  canPlayPcmChunks,
  createStreamingPlayer,
  playInt16ChunkSync,
  playInt16Chunk,
  createChunkQueue
}
