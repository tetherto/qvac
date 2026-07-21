'use strict'

const test = require('brittle')
const { buildBenchmarkArtifactFileName } = require('../utils/artifactName')

const PLATFORM = 'linux-x64'
const BASE = { engine: 'supertonic', variant: 'q4', useGPU: false }

test('a none/none/f16 run keeps the byte-stable pre-axis filename', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, BASE),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu.json',
    'no enhancer/denoiser tokens when both axes are off'
  )
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, {
      ...BASE,
      enhancer: 'none',
      denoiser: 'none',
      enhancerVariant: 'f16'
    }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu.json',
    'explicit none/none/f16 is identical to the bare default'
  )
})

test('the -lavasr token is inserted only when the enhancer is on', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, { ...BASE, enhancer: 'lavasr' }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu-lavasr.json',
    'enhancer on -> -lavasr'
  )
  t.absent(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, {
      ...BASE,
      enhancer: 'none'
    }).includes('lavasr'),
    'enhancer off -> no -lavasr'
  )
})

test('the fp16 default adds no quant tier token (byte-stable) but q8_0 does', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, {
      ...BASE,
      enhancer: 'lavasr',
      enhancerVariant: 'f16'
    }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu-lavasr.json',
    'fp16 enhancer stays plain -lavasr'
  )
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, {
      ...BASE,
      enhancer: 'lavasr',
      enhancerVariant: 'q8_0'
    }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu-lavasr-q8_0.json',
    'a non-fp16 tier follows the -lavasr token'
  )
})

test('the quant tier is inert when the enhancer is off', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, {
      ...BASE,
      enhancer: 'none',
      enhancerVariant: 'q8_0'
    }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu.json',
    'no enhancer -> no tier token even for a quant'
  )
})

test('the -denoise token is inserted only when the denoiser is on', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, { ...BASE, denoiser: 'lavasr' }),
    'rtf-benchmark-linux-x64-supertonic-q4-cpu-denoise.json',
    'denoiser on -> -denoise'
  )
})

test('enhancer, quant tier, denoise and label tokens are ordered deterministically', (t) => {
  t.is(
    buildBenchmarkArtifactFileName('streaming-benchmark', PLATFORM, {
      engine: 'supertonic',
      variant: 'q4',
      useGPU: true,
      enhancer: 'lavasr',
      enhancerVariant: 'q8_0',
      denoiser: 'lavasr',
      label: 'run7'
    }),
    'streaming-benchmark-linux-x64-supertonic-q4-gpu-lavasr-q8_0-denoise-run7.json',
    'prefix, platform, engine, variant, gpu, -lavasr, tier, -denoise, label'
  )
})

test('the prefix distinguishes the RTF and streaming artifacts', (t) => {
  t.ok(
    buildBenchmarkArtifactFileName('rtf-benchmark', PLATFORM, BASE).startsWith('rtf-benchmark-'),
    'RTF prefix'
  )
  t.ok(
    buildBenchmarkArtifactFileName('streaming-benchmark', PLATFORM, BASE).startsWith(
      'streaming-benchmark-'
    ),
    'streaming prefix'
  )
})
