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
  'translation-nmtcpp',
  'tts-ggml',
  'vla',
]

export const BOT_LOGIN = 'github-actions[bot]'

// A prebuild counts as a pass when it actually succeeded or reused a cached
// artifact. A `skipped` prebuild is trusted ONLY when it was skipped for a
// legitimate reason: the ci-router job succeeded and decided not to build
// (run_prebuilds == 'false', i.e. no prebuild label). Any other skip is
// failure-induced - e.g. ci-router (which produces run_prebuilds) errored, so
// the gating condition fell through and the job never ran - and must fail
// closed rather than masquerade as a green prebuild. `reuse_hit` also skips the
// prebuild job (run_prebuilds == 'true', native unchanged) and is a real pass.
export function resolvePublishState(prebuildResult, reuseHit, ciRouterResult, runPrebuilds) {
  if (prebuildResult === 'success' || reuseHit === 'true') return 'success'
  if (prebuildResult === 'skipped') {
    if (ciRouterResult === 'success' && runPrebuilds === 'false') return 'success'
    return 'failure'
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
  // Trusted from either the legacy on-pr-<pkg>.yml or the consolidated on-pr-nx.yml.
  // Keep the per-pkg literal so the ci-trust-policy assertion holds.
  const validPaths = [
    `.github/workflows/on-pr-${pkg}.yml`,
    '.github/workflows/on-pr-nx.yml',
  ]
  if (!run || !validPaths.includes(run.path)) return false
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

// The verify.mjs poll loop, with I/O and timing injected so the retry / deadline
// behaviour is unit-testable. Returns a process exit code (0 pass, 1 fail).
//
// `fetchStatuses` may throw on a transient API error (gh exits non-zero on any
// HTTP 4xx/5xx, incl. routine 502/503 under load; JSON.parse throws on truncated
// output). We retry until the deadline rather than letting one hiccup escape and
// red the gate — the deadline is what turns *persistent* failure into a hard
// fail, keeping fail-closed semantics intact. This mirrors lookupRun's tolerance.
export async function pollPrebuilds({
  expected,
  prUpdatedEpoch,
  fetchStatuses,
  lookupRun,
  now,
  sleep,
  pollIntervalMs,
  timeoutMs,
  log,
}) {
  const deadline = now() + timeoutMs
  for (;;) {
    let statuses
    try {
      statuses = fetchStatuses()
    } catch (err) {
      if (now() >= deadline) {
        log(`::error title=Prebuild verification failed::statuses fetch kept failing: ${err.message}`)
        return 1
      }
      log(`::warning::statuses fetch failed, retrying: ${err.message}`)
      await sleep(pollIntervalMs)
      continue
    }

    const pending = []
    const failed = []
    for (const pkg of expected) {
      const outcome = evaluatePackage(statuses, pkg, prUpdatedEpoch, lookupRun)
      if (outcome === 'failed') failed.push(`qvac/prebuild-${pkg}`)
      else if (outcome === 'pending') pending.push(`qvac/prebuild-${pkg}`)
    }

    if (failed.length > 0) {
      log(`::error title=Prebuild has not returned success::Failing prebuild status(es): ${failed.join(' ')}`)
      return 1
    }
    if (pending.length === 0) {
      log('All required prebuild statuses succeeded (fresh vs this PR event).')
      return 0
    }
    if (now() >= deadline) {
      log(`::error title=Prebuild verification timed out::No fresh terminal prebuild status after timeout for: ${pending.join(' ')}`)
      return 1
    }
    log(`Waiting on prebuild status(es): ${pending.join(' ')} - re-checking in ${Math.round(pollIntervalMs / 1000)}s`)
    await sleep(pollIntervalMs)
  }
}
