'use strict'

// 12 kHz (Nyquist) tone detector for 24 kHz TTS output.
//
// The HiFT ISTFT in Chatterbox / CosyVoice reconstructs the waveform from
// a real spectrogram whose Nyquist bin (f = fs/2) has the time-domain
// basis (-1)^n.  A constant-amplitude Nyquist tone (the "whine") therefore
// shows up as a persistent sign-alternation across the samples.  We measure
// it with the Nyquist DFT coefficient, without a full FFT:
//
//   S = sum_n x[n] * (-1)^n                       // == real DFT bin X[N/2]
//   nyquistEnergyFraction = S^2 / (N * sum_n x[n]^2)   // bounded in [0, 1]
//
// For a pure Nyquist tone this is 1.0; for clean speech it is ~0.  The
// ratio is scale-invariant, so int16 vs float PCM does not matter, and it
// is sample-rate independent (Nyquist is always the highest bin).
//
// Host-validated against known samples (turbo + mtl):
//   toney (Pixel 9a Mali CPU):  nyquistEnergyFraction ~0.63-0.65, zcr ~0.86
//   clean (Adreno CPU / dogfood): nyquistEnergyFraction ~6e-9,    zcr ~0.07
// => threshold 0.1 separates the two classes with a >10^4x margin both
// sides.  ZCR (sign-change rate) is reported as a corroborating signal.

const NYQUIST_FRACTION_THRESHOLD = 0.1

function analyzeNyquistTone (samples, sampleRate) {
  const n = samples ? samples.length : 0
  if (n === 0) {
    return { n: 0, rms: 0, zcr: 0, nyquistEnergyFraction: 0, tonePresent: false, sampleRate: sampleRate || 0 }
  }

  let sumSq = 0
  let alt = 0 // running sum of x[n] * (-1)^n
  let sign = 1 // (-1)^n, starts at +1 for n = 0
  let signChanges = 0
  let prevSign = 0

  for (let i = 0; i < n; i++) {
    const v = samples[i]
    sumSq += v * v
    alt += sign * v
    sign = -sign

    const s = v > 0 ? 1 : (v < 0 ? -1 : 0)
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) signChanges++
      prevSign = s
    }
  }

  const rms = Math.sqrt(sumSq / n)
  const zcr = signChanges / n
  const nyquistEnergyFraction = sumSq > 0 ? (alt * alt) / (n * sumSq) : 0
  const tonePresent = nyquistEnergyFraction > NYQUIST_FRACTION_THRESHOLD

  return { n, rms, zcr, nyquistEnergyFraction, tonePresent, sampleRate: sampleRate || 0 }
}

module.exports = { analyzeNyquistTone, NYQUIST_FRACTION_THRESHOLD }
