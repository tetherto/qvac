'use strict'

// Canonical inventory of native addons that bundle their OWN copy of ggml,
// grouped by the vcpkg stack that provides ggml. Addons from the same stack
// share a ggml symbol set / backend-lib prefix and are co-resident in one
// process in the real SDK consumer:
//
//   speech    -> libqvac-speech-ggml-*   (tts-cpp / whisper.cpp / parakeet)
//   fabric    -> libqvac-ggml-*          (llama.cpp + generic ggml graphs)
//   diffusion -> libqvac-diffusion-ggml-* (stable-diffusion.cpp)
//
// KEEP IN SYNC with the SDK addon map in packages/sdk/schemas/plugin.ts
// (the ADDON_* constants). Short names match the package directory under
// packages/, which is also how the co-load test resolves them on disk.

// `plugin` is the SDK built-in plugin suffix (packages/sdk/commands/bundle/
// constants.ts BUILTIN_PLUGINS); it maps to the bundle specifier
// `@qvac/sdk/<plugin>/plugin` (packages/sdk/schemas/sdk-config.ts) used by the
// mobile (Device Farm) co-load to build a consumer bundling only this subset.
// Addons with no built-in SDK plugin (bci-whispercpp, classification-ggml,
// ocr-ggml) are desktop-only for co-load.
const ADDONS = {
  'tts-ggml': { specifier: '@qvac/tts-ggml', stack: 'speech', plugin: 'tts-ggml' },
  'transcription-parakeet': { specifier: '@qvac/transcription-parakeet', stack: 'speech', plugin: 'parakeet-transcription' },
  'transcription-whispercpp': { specifier: '@qvac/transcription-whispercpp', stack: 'speech', plugin: 'whispercpp-transcription' },
  'bci-whispercpp': { specifier: '@qvac/bci-whispercpp', stack: 'speech' },
  'llm-llamacpp': { specifier: '@qvac/llm-llamacpp', stack: 'fabric', plugin: 'llamacpp-completion' },
  'embed-llamacpp': { specifier: '@qvac/embed-llamacpp', stack: 'fabric', plugin: 'llamacpp-embedding' },
  'classification-ggml': { specifier: '@qvac/classification-ggml', stack: 'fabric' },
  'vla-ggml': { specifier: '@qvac/vla-ggml', stack: 'fabric', plugin: 'ggml-vla' },
  'ocr-ggml': { specifier: '@qvac/ocr-ggml', stack: 'fabric' },
  'translation-nmtcpp': { specifier: '@qvac/translation-nmtcpp', stack: 'fabric', plugin: 'nmtcpp-translation' },
  'diffusion-cpp': { specifier: '@qvac/diffusion-cpp', stack: 'diffusion', plugin: 'sdcpp-generation' }
}

function allNames () {
  return Object.keys(ADDONS)
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

module.exports = { ADDONS, allNames, stacks, resolveSelection }
