// Saves a package's models from a trusted run on main: cache-warm.yml is its only caller, and it refuses any other run,
// since a pull_request_target job shares main's cache scope. per-model saves only files that match their checksum.
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import { cacheKey, cachePaths, firstChecksumMismatch, isComplete, mapWithConcurrency, unplannedPaths } from './plan.mjs'
import { CONCURRENCY, exists, label, lines, message, readPlan } from './common.mjs'

const TRUSTED_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group'])
const SEED_LOOKUP_ATTEMPTS = 3

async function saveEntry(entry) {
  if (await exists(entry)) return 'present'
  if (!isComplete(entry)) {
    core.warning(`Not saving ${label(entry)}: not on disk at ${entry.path}`)
    return 'skipped'
  }
  const mismatch = await firstChecksumMismatch(entry)
  if (mismatch) {
    core.warning(`Not saving ${label(entry)}: ${mismatch} does not match its checksum`)
    return 'mismatch'
  }
  // On cache service v1, saveCache returns an id even when the upload fails.
  const id = await cache.saveCache(cachePaths(entry), cacheKey(entry), {}, true)
  if (await exists(entry, SEED_LOOKUP_ATTEMPTS)) return id === -1 ? 'present' : 'saved'
  core.warning(`Save of ${label(entry)} under ${cacheKey(entry)} did not create an entry`)
  return 'failed'
}

async function perModel(plan) {
  const outcomes = await mapWithConcurrency(plan.entries, CONCURRENCY, (entry) =>
    saveEntry(entry).catch((error) => {
      core.warning(`Save of ${label(entry)} failed: ${message(error)}`)
      return 'failed'
    })
  )
  const count = (outcome) => outcomes.filter((value) => value === outcome).length
  core.info(`💾 saved ${count('saved')}, already cached ${count('present')}, not on disk ${count('skipped')}, mismatched ${count('mismatch')}, failed ${count('failed')}`)
  const drift = plan.checkDrift ? unplannedPaths(plan) : []
  if (drift.length)
    core.warning(`The cache directory holds ${drift.length} item(s) no plan entry covers, so they download every run: ${drift.slice(0, 20).join(', ')}`)
  // A planned model this run never downloaded is skipped; a checksum mismatch or a failed upload fails the warm.
  const unsaved = count('mismatch') + count('failed')
  if (unsaved) core.setFailed(`${unsaved} model cache entr(ies) could not be saved`)
}

async function all(paths, key) {
  if (await cache.restoreCache(paths, key, [], { lookupOnly: true }, true)) return core.info(`${key} is already cached`)
  await cache.saveCache(paths, key, {}, true)
  core.info(`Saved ${key}`)
}

async function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const ref = process.env.GITHUB_REF ?? ''
  if (!TRUSTED_EVENTS.has(event) || ref !== 'refs/heads/main') {
    core.warning(`Not saving model cache entries from a ${event || 'unknown'} run on ${ref}`)
    return
  }
  const mode = core.getInput('mode') || 'all'
  if (mode === 'per-model') await perModel(readPlan(core.getInput('plan', { required: true })))
  else if (mode === 'all') await all(lines(core.getInput('paths', { required: true })), core.getInput('key', { required: true }))
  else throw new Error(`mode must be all or per-model, got "${mode}"`)
}

main().catch((error) => core.setFailed(message(error)))
