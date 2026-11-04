// See action.yml for the contract.
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  cacheKey,
  cachePaths,
  firstChecksumMismatch,
  isComplete,
  mapWithConcurrency,
  unplannedPaths,
  validatePlan
} from './entries.mjs'

// Never save from PR code (A13). Callers gate the step too; this catches a mis-wired caller.
const TRUSTED_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group'])
const CONCURRENCY = 4

// After saveCache returns -1, a seed waits for another job finalizing the same entry; a test leg
// checks once, so a server rejecting writes does not cost it minutes.
const SEED_LOOKUP_ATTEMPTS = 3
const LOOKUP_DELAY_MS = 20_000

const label = (entry) => entry.models.join(',')
const message = (error) => (error instanceof Error ? error.message : String(error))
const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`

async function exists(entry, attempts = 1) {
  const [paths, key] = [cachePaths(entry), cacheKey(entry)]
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(LOOKUP_DELAY_MS)
    if (await cache.restoreCache(paths, key, [], { lookupOnly: true }, true)) return true
  }
  return false
}

async function restoreEntry(entry, lookupOnly) {
  if (lookupOnly) return exists(entry)
  const key = cacheKey(entry)
  if (!(await cache.restoreCache(cachePaths(entry), key, [], {}, true))) return false
  if (isComplete(entry)) return true
  core.warning(`Restored ${label(entry)} is incomplete; if this repeats: gh cache delete ${key}`)
  return false
}

async function restore(plan, lookupOnly) {
  const started = Date.now()
  const hits = await mapWithConcurrency(plan.entries, CONCURRENCY, (entry) =>
    restoreEntry(entry, lookupOnly).catch((error) => {
      core.warning(`Restore of ${label(entry)} failed: ${message(error)}`)
      return false
    })
  )
  const restored = plan.entries.filter((_, index) => hits[index])
  // Unresolved constants have no entry; the bootstrap still fetches them.
  const toDownload = [
    ...plan.entries.filter((_, index) => !hits[index]).flatMap((entry) => entry.models),
    ...plan.unresolved
  ]
  const bytes = restored.reduce((sum, entry) => sum + entry.size, 0)
  core.info(
    `📦 ${restored.length}/${plan.entries.length} model(s) ${lookupOnly ? 'present' : 'restored'} ` +
      `(${gigabytes(bytes)}) in ${Math.round((Date.now() - started) / 1000)}s; ` +
      `${toDownload.length} to download`
  )
  for (const name of toDownload) core.info(`   to download: ${name}`)

  core.setOutput('hits', String(restored.length))
  core.setOutput('complete', String(toDownload.length === 0))
  core.setOutput('missing-models', JSON.stringify(toDownload))
}

async function saveEntry(entry, lookupAttempts) {
  if (await exists(entry)) return 'present'
  if (!isComplete(entry)) {
    core.warning(`Not saving ${label(entry)}: not on disk at ${entry.path}`)
    return 'skipped'
  }
  const mismatch = await firstChecksumMismatch(entry)
  if (mismatch) {
    core.warning(`Not saving ${label(entry)}: ${mismatch} does not match its registry checksum`)
    return 'skipped'
  }
  // saveCache swallows its errors and returns -1; a lookup decides whether the entry exists.
  if ((await cache.saveCache(cachePaths(entry), cacheKey(entry), {}, true)) !== -1) return 'saved'
  if (await exists(entry, lookupAttempts)) return 'present'
  core.warning(`Save of ${label(entry)} under ${cacheKey(entry)} did not create an entry`)
  return 'failed'
}

async function save(plan, failOnError) {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  if (!TRUSTED_EVENTS.has(event)) {
    core.warning(`Not saving model cache entries from a ${event || 'unknown'} run`)
    return
  }
  const outcomes = await mapWithConcurrency(plan.entries, CONCURRENCY, (entry) =>
    saveEntry(entry, failOnError ? SEED_LOOKUP_ATTEMPTS : 1).catch((error) => {
      core.warning(`Save of ${label(entry)} failed: ${message(error)}`)
      return 'failed'
    })
  )
  const count = (outcome) => outcomes.filter((value) => value === outcome).length
  core.info(
    `💾 saved ${count('saved')}, already cached ${count('present')}, ` +
      `not saved ${count('skipped')}, failed ${count('failed')}`
  )

  const drift = unplannedPaths(plan)
  if (drift.length > 0) {
    core.warning(
      `The SDK cache holds ${drift.length} item(s) no plan entry covers, so they are downloaded ` +
        'on every run. packages/inference/src/utils/cache/layout.ts may no longer match the ' +
        `loader: ${drift.slice(0, 20).join(', ')}${drift.length > 20 ? ', ...' : ''}`
    )
  }

  const unsaved = count('skipped') + count('failed')
  if (failOnError && unsaved > 0) {
    core.setFailed(`${unsaved} model cache entr(ies) could not be saved`)
  }
}

async function main() {
  const mode = core.getInput('mode', { required: true })
  const planPath = core.getInput('plan', { required: true })
  let plan
  try {
    plan = validatePlan(JSON.parse(fs.readFileSync(planPath, 'utf8')))
  } catch (error) {
    throw new Error(`${planPath}: ${message(error)}`)
  }

  if (mode === 'restore') await restore(plan, core.getBooleanInput('lookup-only'))
  else if (mode === 'save') await save(plan, core.getBooleanInput('fail-on-save-error'))
  else throw new Error(`mode must be restore or save, got "${mode}"`)
}

main().catch((error) => core.setFailed(message(error)))
