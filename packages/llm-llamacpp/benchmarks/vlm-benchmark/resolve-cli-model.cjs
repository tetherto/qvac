'use strict'
// Resolve the several-sources model to shell variables for the workflow's native-CLI step,
// the same way harness.cjs runAll() does, so both legs read the same two files.
//
// Usage: node resolve-cli-model.cjs > "$RUNNER_TEMP/cli-model.env" && . "$RUNNER_TEMP/cli-model.env"
// Outside the workspace, because a URL here can be a presigned link, which is a bearer
// credential, and a self-hosted runner's workspace outlives the job.
//
// A registry source emits an empty URL: those are addon-only, so the caller has to find the
// blob on disk or fail.

const { parseModels } = require('./models.cjs')
const { serializeCliArgs } = require('./cli-args.cjs')
const config = require('./config.cjs')

// A json: spec supplies repo, sha and file, and this URL is the one the workflow sends the
// HF token to. Constrain each part to the characters a real HF path uses so a spec cannot
// steer the authenticated request off the resolve path it is meant to hit.
//
// `file` is a path, not a single segment: HF repos nest, and the pair form accepts URLs
// like .../resolve/<sha>/tinyllamas/stories260K.gguf. So allow `/` between segments while
// rejecting anything that could climb or escape: an empty segment, `.`, or `..`.
const HF_SEGMENT_RE = /^[\w.-]+$/
const HF_REPO_RE = /^[\w.-]+\/[\w.-]+$/

function checkedHfPath (value, what) {
  const segments = String(value == null ? '' : value).split('/')
  if (!segments.length || segments.some(seg => seg === '' || seg === '.' || seg === '..' || !HF_SEGMENT_RE.test(seg))) {
    throw new Error(`hf source: ${what} must be a path of plain segments with no '.' or '..' (got '${String(value).slice(0, 60)}')`)
  }
  return value
}

function hfUrl (s) {
  if (!HF_REPO_RE.test(String(s.repo || ''))) {
    throw new Error(`hf source: repo must be '<owner>/<name>' (got '${String(s.repo).slice(0, 60)}')`)
  }
  // A commit sha is always one segment; only `file` may nest.
  if (!HF_SEGMENT_RE.test(String(s.sha || ''))) {
    throw new Error(`hf source: sha must be a bare path segment (got '${String(s.sha).slice(0, 60)}')`)
  }
  checkedHfPath(s.file, 'file')
  return `https://huggingface.co/${s.repo}/resolve/${s.sha}/${s.file}`
}

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

// sha256 for the workflow to check a fetched blob against. The addon leg gets this for
// free, since ensureModel() verifies the manifest pin, but a CLI-only dispatch fetches the
// URL itself and had nothing to compare against. Prefer a spec's own sha256 so a json: blob
// outside the manifest can still be pinned; empty means unverifiable and the caller warns.
// The manifest is required directly rather than through test/integration/utils, which is a
// bare-runtime module and cannot load under plain node.
const manifest = require('../../test/integration/models.manifest.json')

function blobSha256 (blob) {
  if (blob.sha256) return String(blob.sha256)
  const entry = manifest.models[blob.modelName]
  return (entry && entry.sha256) || ''
}

// Report Source column, same mapping as harness.cjs sourceType().
function sourceKind (blob) {
  if (blob.registry) return 'Registry'
  const t = (blob.source && blob.source.type) || ''
  return ({ hf: 'HF', s3: 'S3', url: 'URL' })[t] || (t || '—')
}

// Single-quote for `.`-sourcing. A literal quote is escaped the shell way rather than
// stripped, so an origin or label carrying an apostrophe round-trips instead of coming
// out silently altered.
const sh = (name, value) => `${name}='${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`

const spec = parseModels(process.env.QVAC_VLM_MODELS, config.catalog, [config.sourcesModel])[0]

console.log([
  sh('LLM_NAME', spec.llm.modelName),
  sh('LLM_URL', blobUrl(spec.llm)),
  sh('LLM_SHA256', blobSha256(spec.llm)),
  sh('MMPROJ_NAME', spec.mmproj.modelName),
  sh('MMPROJ_URL', blobUrl(spec.mmproj)),
  sh('MMPROJ_SHA256', blobSha256(spec.mmproj)),
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
