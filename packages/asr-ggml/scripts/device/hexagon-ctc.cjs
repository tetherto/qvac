'use strict'

// Development-only standalone Android Bare entrypoint. It never skips missing inputs or
// unavailable backends. Profile and timing runs must use separate processes.
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { spawnSync } = require('bare-subprocess')
const {
  requireCondition,
  wordErrorRate,
  assertBackend,
  assertEnvironment
} = require('./hexagon-validation.cjs')

const report = { results: [] }

function marker(kind, value) {
  // Native MODULE backends log directly to stderr. Synchronous stdout writes
  // keep these windows ordered when the caller captures both streams with 2>&1.
  fs.writeSync(1, `HEXAGON_CTC_${kind} ${JSON.stringify(value)}\n`)
}

function verifyHash(filename, expected) {
  requireCondition(
    typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected),
    `Missing SHA256 for ${filename}`
  )
  const result = spawnSync('/system/bin/sha256sum', [filename])
  requireCondition(result.status === 0, `sha256sum failed for ${filename}`)
  const actual = result.stdout.toString().trim().split(/\s+/)[0]
  requireCondition(actual === expected, `SHA256 mismatch for ${filename}`)
  return actual
}

async function main() {
  const [manifestPath, mode] = process.argv.slice(2)
  requireCondition(process.platform === 'android', 'Run this entrypoint on the Android device')
  requireCondition(
    manifestPath && ['timing', 'profile'].includes(mode),
    'Usage: bare hexagon-ctc.cjs manifest.json timing|profile'
  )
  assertEnvironment(process.env, mode)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const resolve = (name) => path.resolve(path.dirname(manifestPath), name)
  requireCondition(
    manifest.modelType === 'parakeet-ctc-0.6b' && manifest.quantization === 'q8_0',
    'Manifest must identify Parakeet CTC 0.6B Q8_0'
  )
  requireCondition(
    manifest.samples?.length === 2 &&
      manifest.samples[0].seconds === 30 &&
      manifest.samples[1].seconds === 60,
    'Manifest must contain frozen 30s and 60s samples, in that order'
  )
  const ASRGgml = require('../../index.js')
  const nativeLogging = require('../../addonLogging.js')
  Object.assign(report, {
    mode,
    timingKind: 'single-run integration smoke; not a performance benchmark',
    model: manifest.model
  })
  report.modelSha256 = verifyHash(resolve(manifest.model), manifest.modelSha256)
  report.audioSha256 = manifest.samples.map((sample) =>
    verifyHash(resolve(sample.pcm), sample.sha256)
  )
  const backends = mode === 'profile' ? ['hexagon'] : ['cpu', 'opencl', 'hexagon']
  for (const backend of backends) {
    nativeLogging.setLogger((_priority, message) => {
      if (mode === 'profile') {
        fs.writeSync(1, message + '\n')
      }
    })
    const model = new ASRGgml({
      files: { model: resolve(manifest.model) },
      config: { engine: 'parakeet', parakeetConfig: { backend, maxThreads: 4 } }
    })
    try {
      await model.load()
      const info = model.getBackendInfo()
      let previousStats = {}
      for (const sample of manifest.samples) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const pcm = fs.readFileSync(resolve(sample.pcm))
        requireCondition(
          pcm.length === sample.seconds * 16000 * 2,
          'Audio must be exact-duration 16 kHz mono s16le PCM'
        )
        const transcript = []
        const identity = { sample: sample.pcm, seconds: sample.seconds, sha256: sample.sha256 }
        if (mode === 'profile') marker('PROFILE_BEGIN', identity)
        const response = await model.run(pcm)
        await response
          .onUpdate((output) => {
            for (const segment of Array.isArray(output) ? output : [output]) {
              if (segment.text && segment.toAppend) transcript.push(segment.text)
            }
          })
          .await()
        const nativeStats = response.stats
        const stats = { ...nativeStats }
        for (const key of [
          'totalWallMs',
          'totalTime',
          'audioDurationMs',
          'encoderMs',
          'decoderMs',
          'melSpecMs',
          'totalSamples',
          'totalTokens',
          'processCalls',
          'totalTranscriptions',
          'totalEncodedFrames'
        ]) {
          stats[key] -= previousStats[key] || 0
        }
        previousStats = nativeStats
        assertBackend(backend, info, stats)
        const text = transcript.join('')
        requireCondition(text.trim().length > 0, 'Empty transcription')
        requireCondition(
          !/^\[.*\]$/.test(text.trim()),
          `Native inference returned a sentinel: ${text}`
        )
        const wer = wordErrorRate(sample.reference, text)
        const result = {
          backend,
          ...identity,
          text,
          wer,
          info,
          stats
        }
        report.results.push(result)
        console.log('HEXAGON_CTC_SAMPLE ' + JSON.stringify(result))
        if (mode === 'profile') {
          await new Promise((resolve) => setTimeout(resolve, 100))
          marker('PROFILE_END', identity)
        }
        if (mode === 'timing') {
          result.rtf = stats.totalWallMs / stats.audioDurationMs
          if (backend === 'hexagon') {
            const cpu = report.results.find(
              (item) => item.backend === 'cpu' && item.sample === sample.pcm
            )
            requireCondition(
              wer <= cpu.wer + 0.01 + 1e-12,
              `Hexagon WER exceeds CPU by more than one percentage point on ${sample.pcm}`
            )
          }
        }
      }
    } finally {
      await model.destroy()
    }
    // Drain addon logs; separately-loaded backend logs are captured on stderr.
    await new Promise((resolve) => setTimeout(resolve, 100))
    nativeLogging.releaseLogger()
  }
  if (mode === 'profile') {
    report.evidence = 'pending external validation'
    marker('PROFILE_CAPTURE', report)
  } else {
    marker('RESULT', report)
  }
}

main().catch((error) => {
  report.error = error.message
  marker('FAILED', report)
  console.error(error.stack || error)
  process.exitCode = 1
})
