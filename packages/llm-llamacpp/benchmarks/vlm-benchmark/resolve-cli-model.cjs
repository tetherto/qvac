'use strict'
// Resolve the several-sources model to shell variables for the workflow's native-CLI
// step. Same resolution as harness.cjs runAll(): the QVAC_VLM_MODELS launch param
// (first token) if set, else config.sourcesModel. The CLI legs need the on-disk blob
// names (what the addon leg downloads, `modelName`), the download URLs (so a CLI-only
// comparison can fetch them with no addon leg), and the provenance strings the report
// prints per source.
//
// Usage: node resolve-cli-model.cjs > cli-model.env && . ./cli-model.env
// Emits LLM_NAME/LLM_URL, MMPROJ_NAME/MMPROJ_URL, MAIN_ORIGIN/MMPROJ_ORIGIN,
// MODEL_LABEL, MAIN_SOURCE/MMPROJ_SOURCE.
// URL is empty for registry-type sources (P2P, addon-only), and the caller must
// error out if the blob is not already on disk.

const { parseModels } = require('./models.cjs')
const config = require('./config.cjs')

const hfUrl = (s) => `https://huggingface.co/${s.repo}/resolve/${s.sha}/${s.file}`

function blobUrl (blob) {
  if (blob.downloadUrl) return blob.downloadUrl
  const s = blob.source || {}
  if (s.type === 'hf') return hfUrl(s)
  if (s.type === 'url' || s.type === 's3') return s.url || ''
  return ''
}

// Report Source column, same mapping as harness.cjs sourceType().
function sourceKind (blob) {
  if (blob.registry) return 'Registry'
  const t = (blob.source && blob.source.type) || ''
  return ({ hf: 'HF', s3: 'S3', url: 'URL' })[t] || (t || 'URL')
}

// Single-quote for `.`-sourcing. A literal quote is escaped the shell way rather than
// stripped, so an origin or label carrying an apostrophe round-trips instead of coming
// out silently altered.
const sh = (name, value) => `${name}='${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`

const spec = parseModels(process.env.QVAC_VLM_MODELS, config.catalog, [config.sourcesModel])[0]

console.log([
  sh('LLM_NAME', spec.llm.modelName),
  sh('LLM_URL', blobUrl(spec.llm)),
  sh('MMPROJ_NAME', spec.mmproj.modelName),
  sh('MMPROJ_URL', blobUrl(spec.mmproj)),
  sh('MAIN_ORIGIN', spec.llm.origin || spec.llm.modelName),
  sh('MMPROJ_ORIGIN', spec.mmproj.origin || spec.mmproj.modelName),
  sh('MODEL_LABEL', spec.label),
  sh('MAIN_SOURCE', sourceKind(spec.llm)),
  sh('MMPROJ_SOURCE', sourceKind(spec.mmproj)),
  // Model-specific flags for the fabric CLI only: these are fork additions, so passing
  // them to upstream-cli would abort it on an unknown argument.
  sh('CLI_EXTRA_ARGS', (spec.cliArgs || []).join(' '))
].join('\n'))
