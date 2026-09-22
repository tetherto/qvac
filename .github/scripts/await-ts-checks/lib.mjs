// Pure, injectable logic for the PR-head TypeScript-check poller. Kept separate
// from await.mjs so the conclusion handling and the polling loop are unit-tested
// (.github/scripts/test/await-ts-checks.test.mjs) instead of living only in a
// workflow script block.

// A completed check-run conclusion maps to one of:
//   'pass' - the PR-head check succeeded, or was intentionally not run.
//   'fail' - a real, terminal failure.
//   'wait' - not terminal for us: a superseding producer run is expected (the
//            producer uses cancel-in-progress), so keep polling for the fresh one.
//
// 'skipped' is a PASS. The producer gates each <pkg>-pr-head-ts-checks job on
// `contains(matrix.outputs.tspackages, '<pkg>')`, so a skip means nx decided the
// package's TypeScript is not affected by this PR — there is nothing to gate on.
// Treating it as a failure made every PR that touches a package's WORKFLOW but
// not its code unmergeable: the consumer triggers on `.github/workflows/*<pkg>*`
// while the producer only triggers on `packages/**`.
//
// This is not fail-open. A skip caused by the producer erroring (a failed
// `matrix` job leaves tspackages unset, so the `if` is false) still shows up as
// that job's own red check on the PR, independently of this gate.
export function classifyConclusion(conclusion) {
  if (conclusion === 'success' || conclusion === 'skipped') return 'pass'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
    return 'fail'
  }
  return 'wait'
}

// Locates the producer check run on the PR head.
//
// Callers pass the job-level name a reusable-workflow call produces, e.g.
// 'llm-pr-head-ts-checks / ts-checks' (caller job / called job). When the
// CALLER job's `if` is false the called workflow never starts, so that nested
// check run is never created — GitHub records a single run under the bare
// caller-job name with conclusion 'skipped'. Polling only for the nested name
// then times out after 25 minutes instead of passing.
//
// The bare name is accepted only for a completed 'skipped' run. Any other
// outcome means the caller job did run, so the nested check run exists and the
// exact name is still required: this widens the match, not the pass criteria.
export function findCheck(checkRuns, checkName) {
  const rows = checkRuns ?? []
  const exact = rows.find(({ name }) => name === checkName)
  if (exact) return exact

  const separator = checkName.indexOf(' / ')
  if (separator === -1) return undefined
  const callerJob = checkName.slice(0, separator)
  const bare = rows.find(({ name }) => name === callerJob)
  if (bare && bare.status === 'completed' && bare.conclusion === 'skipped') return bare
  return undefined
}

// Polls for a check run named `checkName` on the PR head. Returns 0 on success,
// 1 on failure/timeout. Fails closed: it returns 0 only for a completed run that
// findCheck matched and classifyConclusion calls a pass. All I/O is injected so
// the loop is testable:
//   fetchChecks() -> array of { name, status, conclusion } (may throw)
//   now() -> epoch ms; sleep(ms) -> Promise; log(msg) -> void
export async function pollForCheck({ checkName, fetchChecks, now, sleep, pollIntervalMs, timeoutMs, log }) {
  const deadline = now() + timeoutMs
  for (;;) {
    let checkRuns
    try {
      checkRuns = await fetchChecks()
    } catch (err) {
      // Transient API error (rate limit / 5xx): keep polling, do not red the gate.
      if (now() >= deadline) {
        log(`::error title=Await PR-head TypeScript checks failed::${checkName} lookup kept failing: ${err.message}`)
        return 1
      }
      log(`::warning::${checkName} lookup failed, retrying: ${err.message}`)
      await sleep(pollIntervalMs)
      continue
    }

    const check = findCheck(checkRuns, checkName)
    if (check && check.status === 'completed') {
      const verdict = classifyConclusion(check.conclusion)
      if (verdict === 'pass') {
        log(
          check.conclusion === 'skipped'
            ? `${check.name} was skipped — nx found no affected TypeScript for this package; nothing to gate on.`
            : `${checkName} succeeded.`
        )
        return 0
      }
      if (verdict === 'fail') {
        log(
          `::error title=Await PR-head TypeScript checks failed::${check.name} completed with conclusion: ${check.conclusion}`
        )
        return 1
      }
      // 'wait': cancelled / neutral / stale - a superseding run is expected.
    }

    if (now() >= deadline) {
      log(`::error title=Await PR-head TypeScript checks timed out::Timed out waiting for ${checkName}`)
      return 1
    }
    await sleep(pollIntervalMs)
  }
}
