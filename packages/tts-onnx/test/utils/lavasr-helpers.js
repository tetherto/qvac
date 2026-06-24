'use strict'

const path = require('bare-path')

function lavasrEnhancerConfig (lavasrDir, opts = {}) {
  return {
    type: 'lavasr',
    enhance: opts.enhance !== false,
    denoise: opts.denoise || false,
    backbonePath: path.join(lavasrDir, 'enhancer_backbone.onnx'),
    specHeadPath: path.join(lavasrDir, 'enhancer_spec_head.onnx'),
    denoiserPath: path.join(lavasrDir, 'denoiser_core_legacy_fixed63.onnx')
  }
}

function loadReferenceAudio () {
  const { readWavAsFloat32, resampleLinear } = require('./wav-helper')
  const refPath = path.join(__dirname, '..', 'reference-audio', 'jfk.wav')
  const { samples, sampleRate } = readWavAsFloat32(refPath)
  if (sampleRate !== 24000) {
    return resampleLinear(samples, sampleRate, 24000)
  }
  return samples
}

module.exports = { lavasrEnhancerConfig, loadReferenceAudio }
