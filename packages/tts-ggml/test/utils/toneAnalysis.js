'use strict'

// QVAC-20557 — audio-correctness metrics for the Chatterbox Mali fixes.
// Run under `bare` (reuses wav-helper's bare-fs reader). All measures operate on
// normalised Float32 samples in [-1, 1].
//
// Two device-specific bugs motivate these metrics, both calibrated on real
// Pixel-9a audio (see chatterbox-audio-correctness.test.js):
//   - Bug 1 (CPU/SVE): a constant ~12 kHz line = the Nyquist frequency of the
//     24 kHz output. nyquistEnergyFraction is the decisive gate (clean ~1e-8 vs
//     toney ~0.635).
//   - Bug 2 (Mali GPU): the CFM miscompute collapses synthesis into "blank +
//     beeps" (mostly silence). It carries NO Nyquist energy, so it is caught by
//     activeFraction instead (clean ~0.60 vs broken ~0.28).

const { readWavAsFloat32 } = require('./wav-helper')

// Exact Nyquist-bin (f = SR/2) energy fraction, FFT-free via Parseval on the
// alternating sum: X[N/2] = Σ s[n]·(-1)^n, energy_Nyq = (1/N)|X[N/2]|^2,
// total = Σ s[n]^2  =>  frac = (Σ s[n]·(-1)^n)^2 / (N · Σ s[n]^2).
// 1.0 for a pure ±A·(-1)^n tone, ~0 for DC / band-limited speech. Scale-invariant.
function nyquistEnergyFraction (samples) {
  if (!samples || samples.length === 0) return 0
  let alt = 0
  let energy = 0
  let sign = 1
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    alt += sign * x
    energy += x * x
    sign = -sign
  }
  if (energy <= 0) return 0
  return (alt * alt) / (samples.length * energy)
}

// RMS amplitude of the (normalised) signal.
function rmsEnergy (samples) {
  if (!samples || samples.length === 0) return 0
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]
  return Math.sqrt(s / samples.length)
}

// Fraction of 20 ms frames that are "voiced/active": frame-RMS exceeds both 2% of
// the clip peak and an absolute floor (0.005). Continuous speech is active most of
// the time (~0.6); a "blank + beeps" collapse is active only briefly (~0.28).
function activeFraction (samples, sampleRate) {
  if (!samples || samples.length === 0) return 0
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i]
    if (a > peak) peak = a
  }
  const frame = Math.max(1, Math.round(sampleRate * 0.02))
  const floor = Math.max(0.005, 0.02 * peak)
  let active = 0
  let frames = 0
  for (let off = 0; off + frame <= samples.length; off += frame) {
    let s = 0
    for (let i = 0; i < frame; i++) s += samples[off + i] * samples[off + i]
    if (Math.sqrt(s / frame) > floor) active++
    frames++
  }
  return frames > 0 ? active / frames : 0
}

// In-place iterative radix-2 Cooley–Tukey FFT (re/im, length must be a power of 2).
function fftRadix2 (re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = i + k + len / 2
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr; im[b] = im[a] - vi
        re[a] = re[a] + vr; im[a] = im[a] + vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// Fraction of spectral energy above cutoffHz, summed over non-overlapping 8192-pt
// frames. Cross-check for the alternating-sum measure.
function highBandEnergyFraction (samples, sampleRate, cutoffHz = 10000) {
  const FRAME = 8192
  if (!samples || samples.length < FRAME) return nyquistEnergyFraction(samples)
  const binHz = sampleRate / FRAME
  const cutBin = Math.max(1, Math.floor(cutoffHz / binHz))
  let hi = 0
  let tot = 0
  for (let off = 0; off + FRAME <= samples.length; off += FRAME) {
    const re = new Float64Array(FRAME)
    const im = new Float64Array(FRAME)
    for (let i = 0; i < FRAME; i++) re[i] = samples[off + i]
    fftRadix2(re, im)
    for (let k = 1; k <= FRAME / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      tot += p
      if (k >= cutBin) hi += p
    }
  }
  return tot > 0 ? hi / tot : 0
}

function analyzeSamples (samples, sampleRate) {
  return {
    sampleRate,
    samples: samples ? samples.length : 0,
    nyquistEnergyFraction: nyquistEnergyFraction(samples),
    highBandEnergyFraction: highBandEnergyFraction(samples, sampleRate, 10000),
    rms: rmsEnergy(samples),
    activeFraction: activeFraction(samples, sampleRate)
  }
}

function analyzeWav (wavPath) {
  const { samples, sampleRate } = readWavAsFloat32(wavPath)
  return Object.assign({ wav: wavPath }, analyzeSamples(samples, sampleRate))
}

module.exports = {
  nyquistEnergyFraction,
  highBandEnergyFraction,
  rmsEnergy,
  activeFraction,
  analyzeSamples,
  analyzeWav
}
