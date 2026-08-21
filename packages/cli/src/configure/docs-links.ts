// Curated map from an SDK `addon` value to its docs page on
// https://docs.qvac.tether.io. The slug is NOT derivable from the addon/engine
// name, and only some addons have a page (and a config anchor), so this is
// hand-maintained — seeded from the docs sidebar (docs/website/src/lib/custom-tree.ts).
// Trailing slash matters (the site uses trailingSlash: true).

const BASE = 'https://docs.qvac.tether.io'

/** Generic fallback when an addon has no dedicated docs page. */
export const CONFIG_DOCS_URL = `${BASE}/configuration/`

interface AddonDocs {
  url: string
  /** Section anchor for model config, where the page has one (varies per page). */
  configAnchor?: string
}

const ADDON_DOCS: Record<string, AddonDocs> = {
  llm: { url: `${BASE}/addons/llm-llamacpp/`, configAnchor: '#4-create-the-config-obj' },
  embeddings: { url: `${BASE}/addons/embed-llamacpp/`, configAnchor: '#4-create-config' },
  whisper: {
    url: `${BASE}/addons/transcription-whispercpp/`,
    configAnchor: '#2-configure-transcription-parameters'
  },
  parakeet: {
    url: `${BASE}/addons/transcription-parakeet/`,
    configAnchor: '#2-configure-parakeet-parameters'
  },
  nmt: {
    url: `${BASE}/addons/translation-nmtcpp/`,
    configAnchor: '#3-create-the-config-object'
  },
  diffusion: {
    url: `${BASE}/addons/diffusion-cpp/`,
    configAnchor: '#3-configure-the-native-backend-argsconfig'
  },
  // No config anchor on these pages.
  tts: { url: `${BASE}/addons/tts-ggml/` },
  audiogen: { url: `${BASE}/addons/audiogen-ggml/` }
}

/** Real docs URL for an addon (deep-linked to its config section when one
 * exists), or the generic configuration page when the addon has no page. */
export function docsUrlForAddon(addon: string | null | undefined): string {
  const docs = addon ? ADDON_DOCS[addon] : undefined
  if (!docs) return CONFIG_DOCS_URL
  return docs.configAnchor ? `${docs.url}${docs.configAnchor}` : docs.url
}
