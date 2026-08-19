'use strict'

// Canonical inventory of native addons that bundle their OWN copy of ggml,
// grouped by the vcpkg stack that provides ggml. Addons from the same stack
// share a ggml symbol set / backend-lib prefix and are co-resident in one
// process in the real SDK consumer:
//
//   speech    -> libqvac-speech-ggml-*   (tts-cpp / whisper.cpp + parakeet)
//   fabric    -> libqvac-ggml-*          (llama.cpp + generic ggml graphs)
//   diffusion -> libqvac-diffusion-ggml-* (stable-diffusion.cpp)
//
// KEEP IN SYNC with the addons the SDK actually depends on: every entry here
// must be a dependency of packages/sdk/package.json, enforced by
// test/addons.unit.test.js. (packages/sdk/schemas/plugin.ts still exports
// ADDON_* constants for retired packages, so it is not the sync target.) Short
// names match the package directory under packages/, which is also how the
// co-load test resolves them on disk.

// `plugins` lists the SDK built-in plugin suffixes an addon backs
// (packages/sdk/commands/bundle/constants.ts BUILTIN_PLUGINS); each maps to the
// bundle specifier `@qvac/sdk/<plugin>/plugin`
// (packages/sdk/schemas/sdk-config.ts) used by the mobile (Device Farm) co-load
// to build a consumer bundling only this subset. One addon may back several
// plugins -- asr-ggml serves both transcription engines -- so a combo's plugin
// count is NOT its addon count. Addons with no built-in SDK plugin
// (bci-whispercpp, classification-ggml, ocr-ggml) are desktop-only for co-load.
//
// Optional `lifecycle` opts an addon into the model-free reload cycle
// (coload.js#runLifecycle): `{ ctorArgs: [], dispose: 'destroy' }` builds a
// weight-less instance and tears it down `COLOAD_CYCLES` times, interleaved
// across addons, to exercise ggml teardown/re-init interposition. It is left
// UNSET here on purpose: only add it for an addon once its constructor + dispose
// are confirmed to run without model weights on a real runner, otherwise the
// smoke would fail for a reason unrelated to co-loading. Model-driven
// load/unload (with weights) belongs in the SDK e2e, not this model-free smoke.
const ADDONS = {
  'tts-ggml': { specifier: '@qvac/tts-ggml', stack: 'speech', plugins: ['tts-ggml'] },
  'asr-ggml': { specifier: '@qvac/asr-ggml', stack: 'speech', plugins: ['parakeet-transcription', 'whispercpp-transcription'] },
  'bci-whispercpp': { specifier: '@qvac/bci-whispercpp', stack: 'speech' },
  'llm-llamacpp': { specifier: '@qvac/llm-llamacpp', stack: 'fabric', plugins: ['llamacpp-completion'] },
  'embed-llamacpp': { specifier: '@qvac/embed-llamacpp', stack: 'fabric', plugins: ['llamacpp-embedding'] },
  'classification-ggml': { specifier: '@qvac/classification-ggml', stack: 'fabric' },
  'vla-ggml': { specifier: '@qvac/vla-ggml', stack: 'fabric', plugins: ['ggml-vla'] },
  'ocr-ggml': { specifier: '@qvac/ocr-ggml', stack: 'fabric' },
  'translation-nmtcpp': { specifier: '@qvac/translation-nmtcpp', stack: 'fabric', plugins: ['nmtcpp-translation'] },
  'diffusion-cpp': { specifier: '@qvac/diffusion-cpp', stack: 'diffusion', plugins: ['sdcpp-generation'] }
}

function allNames () {
  return Object.keys(ADDONS)
}

function pluginsOf (name) {
  const info = ADDONS[name]
  return (info && info.plugins) || []
}

function withPlugins (names) {
  return names.filter(n => pluginsOf(n).length > 0)
}

// { speech: [...], fabric: [...], diffusion: [...] }
function stacks () {
  const out = {}
  for (const [name, info] of Object.entries(ADDONS)) {
    if (!out[info.stack]) out[info.stack] = []
    out[info.stack].push(name)
  }
  return out
}

// Resolve a COLOAD_ADDONS selection string into a concrete, de-duplicated,
// validated list of addon short names:
//   - undefined / '' / 'all'                  -> every addon
//   - a stack name (speech|fabric|diffusion)  -> that stack's addons
//   - comma-separated names                   -> exactly those
function resolveSelection (selection) {
  const raw = (selection == null ? '' : String(selection)).trim()
  if (raw === '' || raw.toLowerCase() === 'all') return allNames()

  const byStack = stacks()
  if (byStack[raw]) return byStack[raw]

  const names = raw.split(',').map(s => s.trim()).filter(Boolean)
  const unknown = names.filter(n => !ADDONS[n])
  if (unknown.length > 0) {
    throw new Error(
      `Unknown addon(s) in COLOAD_ADDONS: ${unknown.join(', ')}. ` +
      `Known: ${allNames().join(', ')}`
    )
  }
  return [...new Set(names)]
}

module.exports = { ADDONS, allNames, pluginsOf, withPlugins, stacks, resolveSelection }
