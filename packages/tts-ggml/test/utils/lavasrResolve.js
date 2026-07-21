'use strict'

// Shared LavaSR enhancer / denoiser resolution for the RTF and streaming
// benchmark suites. Centralizing it here means the two suites can never drift on
// the fetch options or the published-vs-unpublished policy: a published tier
// (fp16/fp32 enhancer, the denoiser) that fails to resolve hard-fails like the
// engine GGUF, while a not-yet-published tier (e.g. q8_0) soft-skips until its
// GGUF lands on S3. The pure decision lives in downloadModel's
// classifyEnhancerResolution / classifyDenoiserResolution (unit-tested there); this
// module only wires the async fetch to a throw / skip / path.
const path = require('bare-path')
const {
  ensureLavaSREnhancerGguf,
  ensureLavaSRDenoiserGguf,
  classifyEnhancerResolution,
  classifyDenoiserResolution
} = require('./downloadModel')

function enhancerFetchOptions(settings, baseDir) {
  const options = {
    targetDir: path.join(baseDir, 'models', 'lavasr'),
    quant: settings.enhancerVariant
  }
  if (settings.enhancerRegistryPath) {
    options.registryPath = settings.enhancerRegistryPath
    if (settings.enhancerRegistrySource) options.registrySource = settings.enhancerRegistrySource
  }
  return options
}

function denoiserFetchOptions(settings, baseDir) {
  const options = { targetDir: path.join(baseDir, 'models', 'lavasr') }
  if (settings.denoiserRegistryPath) {
    options.registryPath = settings.denoiserRegistryPath
    if (settings.denoiserRegistrySource) options.registrySource = settings.denoiserRegistrySource
  }
  return options
}

// Resolve the LavaSR enhancer GGUF when the enhancer axis is on. Returns
// `{ path: null }` for the default (enhancer=none), `{ path }` once fetched from
// the QVAC registry (or a local/env-pointed copy), `{ skip, skipReason }` for a
// not-yet-published tier, or throws when a published tier can't be resolved so a
// real registry/network failure surfaces as red instead of a false green.
async function resolveEnhancer(settings, baseDir) {
  if (settings.enhancer !== 'lavasr') return { path: null }
  const result = await ensureLavaSREnhancerGguf(enhancerFetchOptions(settings, baseDir))
  const outcome = classifyEnhancerResolution(result, settings.enhancerVariant)
  if (outcome.fail) throw new Error(outcome.reason)
  if (outcome.skip) return { skip: true, skipReason: outcome.reason }
  return { path: outcome.path }
}

// Resolve the LavaSR denoiser GGUF when the denoiser axis is on. Mirrors
// resolveEnhancer, but the denoiser is published, so an unresolved denoiser
// always throws (no soft-skip tier).
async function resolveDenoiser(settings, baseDir) {
  if (settings.denoiser !== 'lavasr') return { path: null }
  const result = await ensureLavaSRDenoiserGguf(denoiserFetchOptions(settings, baseDir))
  const outcome = classifyDenoiserResolution(result)
  if (outcome.fail) throw new Error(outcome.reason)
  return { path: outcome.path }
}

module.exports = { resolveEnhancer, resolveDenoiser }
