'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const { LamAudio2Expression } = require('../index')

// ---------------------------------------------------------------------------
// Numerical parity gate for LAM audio2expression.
//
// Runs a recorded PCM input through the GGUF model and compares the resulting
// ARKit-52 coefficients against activations dumped from the PyTorch reference.
// This is the tier the tiny random-weight model cannot cover: it is the only
// check that says the arithmetic is right, not merely well-formed.
//
// Fixtures are a directory containing manifest.json plus <case>_input_pcm.bin
// and <case>_expr.bin, as produced by the reference dumper.
//
//   bare scripts/check-lam-a2e-parity.js \
//     --model "$PWD/models/lam-audio2exp-f32.gguf" \
//     --fixtures /path/to/reference --case sec2
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000
const N_COEFFS = 52
const DEFAULT_TOLERANCE = 1e-3

function usage() {
  console.log(`Usage: bare scripts/check-lam-a2e-parity.js --model <gguf> --fixtures <dir> [options]

Options:
  --model <path>       Absolute path to the .gguf under test (required)
  --fixtures <dir>     Directory holding manifest.json + *.bin (required)
  --case <name>        Case from the manifest (default: every case)
  --tolerance <float>  Max allowed absolute difference (default: ${DEFAULT_TOLERANCE})
  -h, --help           Show this message
`)
}

function parseArgs(argv) {
  const opts = { model: '', fixtures: '', case: '', tolerance: DEFAULT_TOLERANCE }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-h':
      case '--help':
        return null
      case '--model':
        opts.model = argv[++i]
        break
      case '--fixtures':
        opts.fixtures = argv[++i]
        break
      case '--case':
        opts.case = argv[++i]
        break
      case '--tolerance':
        opts.tolerance = Number(argv[++i])
        break
      default:
        throw new Error(`unknown option: ${argv[i]}`)
    }
  }
  if (!opts.model) throw new Error('missing --model')
  if (!opts.fixtures) throw new Error('missing --fixtures')
  if (!Number.isFinite(opts.tolerance) || opts.tolerance <= 0) {
    throw new Error(`--tolerance must be a positive number, got: ${opts.tolerance}`)
  }
  return opts
}

function readFloats(filePath) {
  const buf = fs.readFileSync(filePath)
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
}

async function runCase(a2e, fixtureDir, entry) {
  const pcm = readFloats(path.join(fixtureDir, entry.tensors.input_pcm.file))
  const reference = readFloats(path.join(fixtureDir, entry.tensors.expr.file))

  const response = await a2e.run(pcm, {
    sampleRate: SAMPLE_RATE,
    identityIndex: entry.id_idx
  })

  let frames = []
  await response
    .onUpdate((data) => {
      if (typeof data !== 'string') return
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed.frames)) frames = parsed.frames
    })
    .await()

  const [refFrames, refCoeffs] = entry.tensors.expr.shape
  if (frames.length !== refFrames) {
    throw new Error(`frame count mismatch: got ${frames.length}, reference has ${refFrames}`)
  }
  if (refCoeffs !== N_COEFFS) {
    throw new Error(`reference declares ${refCoeffs} coefficients, expected ${N_COEFFS}`)
  }

  let maxDiff = 0
  let sumDiff = 0
  let worst = { frame: -1, coeff: -1, got: 0, want: 0 }

  for (let f = 0; f < refFrames; f++) {
    for (let c = 0; c < N_COEFFS; c++) {
      const got = frames[f].arkit52[c]
      const want = reference[f * N_COEFFS + c]
      const diff = Math.abs(got - want)
      sumDiff += diff
      if (diff > maxDiff) {
        maxDiff = diff
        worst = { frame: f, coeff: c, got, want }
      }
    }
  }

  return { maxDiff, meanDiff: sumDiff / (refFrames * N_COEFFS), worst, frames: refFrames }
}

async function main() {
  let opts
  try {
    opts = parseArgs(proc.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${err.message}\n`)
    usage()
    proc.exit(1)
  }
  if (opts === null) {
    usage()
    return
  }

  const manifestPath = path.join(opts.fixtures, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: no manifest.json in ${opts.fixtures}`)
    proc.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const cases = manifest.cases.filter(
    (c) => (!opts.case || c.case === opts.case) && c.tensors.input_pcm && c.tensors.expr
  )
  if (cases.length === 0) {
    console.error(`Error: no usable cases${opts.case ? ` matching "${opts.case}"` : ''}`)
    proc.exit(1)
  }

  console.log('LAM audio2expression parity')
  console.log('===========================')
  console.log('Model     :', opts.model)
  console.log('Fixtures  :', opts.fixtures)
  console.log('Tolerance :', opts.tolerance)
  console.log()

  const a2e = new LamAudio2Expression({ files: { model: opts.model } })
  await a2e.load()

  let failed = 0
  try {
    for (const entry of cases) {
      const r = await runCase(a2e, opts.fixtures, entry)
      const pass = r.maxDiff <= opts.tolerance
      if (!pass) failed++

      console.log(`${pass ? 'PASS' : 'FAIL'}  ${entry.case}  (${r.frames} frames)`)
      console.log(`        max abs diff  ${r.maxDiff.toExponential(3)}`)
      console.log(`        mean abs diff ${r.meanDiff.toExponential(3)}`)
      console.log(
        `        worst         frame ${r.worst.frame} coeff ${r.worst.coeff}: ` +
          `got ${r.worst.got.toFixed(8)} want ${r.worst.want.toFixed(8)}`
      )
    }
  } finally {
    await a2e.unload()
  }

  console.log()
  if (failed > 0) {
    console.error(`${failed} of ${cases.length} case(s) exceeded tolerance`)
    proc.exit(1)
  }
  console.log(`All ${cases.length} case(s) within tolerance.`)
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  proc.exit(1)
})
