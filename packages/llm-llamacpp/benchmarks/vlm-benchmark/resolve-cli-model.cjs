'use strict'
// Resolve the several-sources model to shell variables for the workflow's native-CLI
// step. Same resolution as harness.cjs runAll(): the QVAC_VLM_MODELS launch param
// (first token) if set, else config.sourcesModel. The CLI legs need the on-disk blob
// names (what the addon leg downloads, `modelName`), the download URLs (so a CLI-only
// comparison can fetch them with no addon leg), and the provenance strings the report
// prints per source.
//
// Usage: node resolve-cli-model.cjs > cli-model.env && . ./cli-model.env
// URL is empty for registry-type sources (P2P, addon-only), and the caller must
// error out if the blob is not already on disk.

const { parseModels } = require('./models.cjs')
const { serializeCliArgs } = require('./cli-args.cjs')
const config = require('./config.cjs')

const hfUrl = (s) => `https://huggingface.co/${s.repo}/resolve/${s.sha}/${s.file}`

// The workflow curls whatever this emits. Empty is fine and handled there (registry
// sources have no URL and need an addon leg), but anything non-empty must be https:
// curl reads a leading dash as an option no matter how the shell quotes it, so a value
// like `--config=/tmp/curlrc` would be obeyed instead of fetched. models.cjs rejects
// these at parse time too; this is the last gate before the value leaves the process.
function checkedUrl (url, what) {
  if (!url) return ''
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    throw new Error(`${what}: refusing to emit a non-https URL ('${String(url).slice(0, 60)}')`)
  }
  return url
}

function blobUrl (blob) {
  if (blob.downloadUrl) return checkedUrl(blob.downloadUrl, 'downloadUrl')
  const s = blob.source || {}
  if (s.type === 'hf') return checkedUrl(hfUrl(s), 'hf source')
  if (s.type === 'url' || s.type === 's3') return checkedUrl(s.url || '', `${s.type} source`)
  return ''
}

// Report Source column, same mapping as harness.cjs sourceType().
function sourceKind (blob) {
  if (blob.registry) return 'Registry'
  const t = (blob.source && blob.source.type) || ''
  return ({ hf: 'HF', s3: 'S3', url: 'URL' })[t] || (t || '?')
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
  // The addon leg runs at spec.ctx_size; without this the CLI legs silently stayed at
  // their own default and the two engines were compared under different contexts.
  sh('CTX_SIZE', spec.ctx_size),
  sh('MAIN_SOURCE', sourceKind(spec.llm)),
  sh('MMPROJ_SOURCE', sourceKind(spec.mmproj)),
  // Model-specific flags for the fabric CLI only: these are fork additions, so passing
  // them to upstream-cli would abort it on an unknown argument.
  sh('CLI_EXTRA_ARGS', serializeCliArgs(spec.cliArgs))
].join('\n'))
