// Pure, unit-tested helpers for the addon prebuild commit-status protocol.
//
// Producer side (on-pr-<pkg>.yml `publish-prebuild-status`): map a prebuild
// outcome to a qvac/prebuild-<pkg> commit status stamped with its own run URL.
// Verifier side (pr-gate-merge.yml `verify-prebuilds`): select the newest
// trustworthy status and bind it to the run that produced it.
//
// Kept free of I/O so the behaviour can be exercised directly by tests; the
// CLIs in publish.mjs / verify.mjs inject the GitHub API calls.

export const PREBUILD_KEYS = [
  'asr-ggml',
  'bci-whispercpp',
  'classification-ggml',
  'diffusion-cpp',
  'embed-llamacpp',
  'fabric',
  'llm-llamacpp',
  'model-fit',
  'ocr-ggml',
  'onnx',
  'translation-nmtcpp',
  'tts-ggml',
  'vla',
]

export const BOT_LOGIN = 'github-actions[bot]'

// A prebuild counts as a pass when it actually succeeded, was legitimately
// skipped (no prebuild label), or reused a cached artifact; else it failed.
export function resolvePublishState(prebuildResult, reuseHit) {
  if (
    prebuildResult === 'success' ||
    prebuildResult === 'skipped' ||
    reuseHit === 'true'
  ) {
    return 'success'
  }
  return 'failure'
}

// Changed packages intersected with the prebuild allowlist.
export function expectedPrebuilds(changedPackages, keys = PREBUILD_KEYS) {
  const allow = new Set(keys)
  return (changedPackages ?? []).filter((pkg) => allow.has(pkg))
}

// `gh api --paginate --slurp` returns one array per page wrapped in an outer
// array; flatten a single level so a context that appears on more than one page
// is considered together. Tolerates an already-flat array of status objects.
export function flattenPages(slurped) {
  if (!Array.isArray(slurped)) return []
  if (slurped.length > 0 && Array.isArray(slurped[0])) return slurped.flat()
  return slurped
}

// Numeric run id embedded in a status target_url, or null.
export function parseRunId(targetUrl) {
  if (typeof targetUrl !== 'string') return null
  const match = targetUrl.match(/\/actions\/runs\/(\d+)(?:$|[/?#])/)
  return match ? match[1] : null
}

// Newest bot-authored status for a context, across all pages, by updated_at.
// The bot filter is defense-in-depth: base-repo statuses already require base
// write, so a fork PR cannot forge one.
export function selectNewestBotStatus(statuses, context) {
  const matching = (statuses ?? []).filter(
    (s) => s && s.context === context && s.creator && s.creator.login === BOT_LOGIN,
  )
  if (matching.length === 0) return null
  return matching.reduce((newest, s) =>
    Date.parse(s.updated_at) >= Date.parse(newest.updated_at) ? s : newest,
  )
}

// Trust the producing run only when it is the matching on-pr-<pkg> workflow AND
// was triggered at/after this PR event (created_at >= threshold, epoch seconds).
// This rejects a superseded pre-label run whose skipped success merely
// post-dates the label.
export function isRunFresh(run, pkg, prUpdatedEpoch) {
  if (!run || run.path !== `.github/workflows/on-pr-${pkg}.yml`) return false
  const createdMs = Date.parse(run.created_at)
  if (Number.isNaN(createdMs)) return false
  return Math.floor(createdMs / 1000) >= prUpdatedEpoch
}

// Map a commit-status state to a gate outcome.
export function classifyState(state) {
  if (state === 'success') return 'success'
  if (state === 'failure' || state === 'error') return 'failed'
  return 'pending'
}

// Full per-package decision: 'success' | 'failed' | 'pending'.
// `lookupRun(runId)` returns the producing run object (or null) and is injected
// so this stays pure and testable.
export function evaluatePackage(statuses, pkg, prUpdatedEpoch, lookupRun) {
  const status = selectNewestBotStatus(statuses, `qvac/prebuild-${pkg}`)
  const runId = status ? parseRunId(status.target_url) : null
  if (!runId) return 'pending'
  const run = lookupRun(runId)
  if (!isRunFresh(run, pkg, prUpdatedEpoch)) return 'pending'
  return classifyState(status.state)
}
