// Pure, injectable logic for the PR-head TypeScript-check poller. Kept separate
// from await.mjs so the conclusion handling and the polling loop are unit-tested
// (.github/scripts/test/await-ts-checks.test.mjs) instead of living only in a
// workflow script block.

// A completed check-run conclusion maps to one of:
//   'pass' - the PR-head check succeeded.
//   'fail' - a real, terminal failure.
//   'wait' - not terminal for us: a superseding producer run is expected (the
//            producer uses cancel-in-progress), so keep polling for the fresh one.
export function classifyConclusion(conclusion) {
  if (conclusion === 'success') return 'pass'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
    return 'fail'
  }
  return 'wait'
}

// Polls for a check run named `checkName` on the PR head. Returns 0 on success,
// 1 on failure/timeout. Fails closed: it returns 0 only for a completed+success
// run whose name matches exactly. All I/O is injected so the loop is testable:
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

    const check = (checkRuns ?? []).find(({ name }) => name === checkName)
    if (check && check.status === 'completed') {
      const verdict = classifyConclusion(check.conclusion)
      if (verdict === 'pass') {
        log(`${checkName} succeeded.`)
        return 0
      }
      if (verdict === 'fail') {
        log(`::error title=Await PR-head TypeScript checks failed::${checkName} completed with conclusion: ${check.conclusion}`)
        return 1
      }
      // 'wait': cancelled / skipped / neutral / stale - a superseding run is expected.
    }

    if (now() >= deadline) {
      log(`::error title=Await PR-head TypeScript checks timed out::Timed out waiting for ${checkName}`)
      return 1
    }
    await sleep(pollIntervalMs)
  }
}
