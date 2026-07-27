'use strict'

// Pure builder for benchmark artifact filenames, shared by the RTF and streaming
// suites so the LavaSR enhancer / quant-tier / denoiser tokens are appended
// identically. Each token is inserted only when its axis is enabled, so a
// none/none/f16 run keeps the exact pre-axis filename (byte-stable). Kept out of
// the brittle benchmark suites (which load the native addon) so it stays
// unit-testable on its own.
const { enhancerTag, enhancerVariantTag, denoiserTag } = require('./downloadModel')

function buildBenchmarkArtifactFileName(prefix, platformArch, settings) {
  const parts = [
    prefix,
    platformArch,
    settings.engine,
    settings.variant,
    settings.useGPU ? 'gpu' : 'cpu'
  ]
  const enhancerToken = enhancerTag(settings.enhancer)
  if (enhancerToken) parts.push(enhancerToken)
  const enhancerVariantToken = enhancerVariantTag(settings.enhancer, settings.enhancerVariant)
  if (enhancerVariantToken) parts.push(enhancerVariantToken)
  const denoiserToken = denoiserTag(settings.denoiser)
  if (denoiserToken) parts.push(denoiserToken)
  if (settings.label) parts.push(settings.label)
  return `${parts.join('-')}.json`
}

module.exports = { buildBenchmarkArtifactFileName }
