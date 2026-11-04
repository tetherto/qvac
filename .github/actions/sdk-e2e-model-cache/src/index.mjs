// See action.yml for the contract.
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  cacheKey,
  cachePaths,
  firstChecksumMismatch,
  formatBytes,
  isComplete,
  mapWithConcurrency,
  unplannedPaths,
  validatePlan
} from './entries.mjs'

// Never save from PR code (A13). Callers gate the step too; this catches a mis-wired caller.
const TRUSTED_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group'])

// After saveCache returns -1, a seed waits for another job finalizing the same entry; a test leg
// checks once, so a server rejecting writes does not cost it minutes.
const SEED_LOOKUP_ATTEMPTS = 3
const LOOKUP_DELAY_MS = 20_000

const label = (entry) => entry.models.join(',')
// Per entry, not per key: identical bytes at two paths share a key.
const stateKey = (prefix, entry) => `${cacheKey(prefix, entry)}\n${entry.paths.join('\n')}`
const statePath = (planPath) => `${planPath}.restore.json`
const message = (error) => (error instanceof Error ? error.message : String(error))

function readPlan(planPath) {
  try {
    return validatePlan(JSON.parse(fs.readFileSync(planPath, 'utf8')))
  } catch (error) {
    throw new Error(`${planPath}: ${message(error)}`)
  }
}

async function restoreEntry(prefix, entry, lookupOnly) {
  const key = cacheKey(prefix, entry)
  try {
    const matched = await cache.restoreCache(cachePaths(entry), key, [], { lookupOnly }, true)
    if (!matched) return { hit: false }
    if (!lookupOnly && !isComplete(entry)) {
      core.warning(
        `Restored ${label(entry)} is incomplete, downloading it again. If this repeats, ` +
          `delete the entry: gh cache delete ${key}`
      )
      return { hit: false }
    }
    return { hit: true }
  } catch (error) {
    core.warning(`Restore of ${label(entry)} failed: ${message(error)}`)
    return { hit: false }
  }
}

async function restore(plan, planPath, prefix, concurrency, lookupOnly) {
  const started = Date.now()
  const results = await mapWithConcurrency(plan.entries, concurrency, (entry) =>
    restoreEntry(prefix, entry, lookupOnly)
  )

  const state = {}
  const missing = []
  let restoredBytes = 0
  plan.entries.forEach((entry, index) => {
    state[stateKey(prefix, entry)] = results[index]
    if (results[index].hit) restoredBytes += entry.expectedSize
    else missing.push(entry)
  })
  fs.writeFileSync(statePath(planPath), `${JSON.stringify(state, null, 2)}\n`)

  // Unresolved constants have no entry; the bootstrap still fetches them.
  const toDownload = [...missing.flatMap((entry) => entry.models), ...plan.unresolved]
  const hits = plan.entries.length - missing.length
  const seconds = Math.round((Date.now() - started) / 1000)
  const verb = lookupOnly ? 'present' : 'restored'
  core.info(
    `📦 ${hits}/${plan.entries.length} model(s) ${verb} (${formatBytes(restoredBytes)}) ` +
      `in ${seconds}s; ${toDownload.length} to download`
  )
  for (const name of toDownload) core.info(`   to download: ${name}`)

  core.setOutput('hits', String(hits))
  core.setOutput('misses', String(missing.length))
  core.setOutput('complete', String(toDownload.length === 0))
  core.setOutput('missing-models', JSON.stringify(toDownload))

  try {
    await core.summary
      .addHeading('SDK e2e model cache', 3)
      .addTable([
        [
          { data: 'Entries', header: true },
          { data: verb, header: true },
          { data: 'To download', header: true },
          { data: 'Transferred', header: true },
          { data: 'Time', header: true }
        ],
        [
          String(plan.entries.length),
          String(hits),
          String(toDownload.length),
          lookupOnly ? 'none (lookup only)' : formatBytes(restoredBytes),
          `${seconds}s`
        ]
      ])
      .addRaw(toDownload.length > 0 ? `\nTo download: ${toDownload.join(', ')}\n` : '')
      .write()
  } catch (error) {
    core.info(`Job summary not written: ${message(error)}`)
  }
}

async function entryExists(paths, key, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(LOOKUP_DELAY_MS)
    if (await cache.restoreCache(paths, key, [], { lookupOnly: true }, true)) return true
  }
  return false
}

async function saveEntry(prefix, entry, previous, lookupAttempts) {
  if (previous?.hit) return 'present'
  if (!isComplete(entry)) {
    core.warning(
      `Not saving ${label(entry)}: not on disk at the planned paths (${entry.paths.join(', ')})`
    )
    return 'skipped'
  }
  const mismatch = await firstChecksumMismatch(entry)
  if (mismatch) {
    core.warning(`Not saving ${label(entry)}: ${mismatch} does not match its registry checksum`)
    return 'skipped'
  }
  const key = cacheKey(prefix, entry)
  const paths = cachePaths(entry)
  try {
    // saveCache swallows its errors and returns -1; a lookup decides whether the entry exists.
    if ((await cache.saveCache(paths, key, {}, true)) !== -1) return 'saved'
    if (await entryExists(paths, key, lookupAttempts)) return 'present'
    core.warning(`Save of ${label(entry)} under ${key} did not create an entry`)
    return 'failed'
  } catch (error) {
    core.warning(`Save of ${label(entry)} failed: ${message(error)}`)
    return 'failed'
  }
}

async function save(plan, planPath, prefix, concurrency, failOnError) {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  if (!TRUSTED_EVENTS.has(event)) {
    core.warning(`Not saving model cache entries from a ${event || 'unknown'} run`)
    return
  }
  const state = fs.existsSync(statePath(planPath))
    ? JSON.parse(fs.readFileSync(statePath(planPath), 'utf8'))
    : {}

  const outcomes = await mapWithConcurrency(plan.entries, concurrency, (entry) =>
    saveEntry(prefix, entry, state[stateKey(prefix, entry)], failOnError ? SEED_LOOKUP_ATTEMPTS : 1)
  )
  const count = (outcome) => outcomes.filter((value) => value === outcome).length
  core.info(
    `💾 saved ${count('saved')}, already cached ${count('present')}, ` +
      `not saved ${count('skipped')}, failed ${count('failed')}`
  )
  core.setOutput('saved', String(count('saved')))

  const drift = unplannedPaths(plan)
  if (drift.length > 0) {
    core.warning(
      `The SDK cache holds ${drift.length} item(s) no plan entry covers, so they are downloaded ` +
        'on every run. The layout mirror in packages/sdk-e2e/runners/js/shared/model-cache-plan.ts ' +
        `may be out of date: ${drift.slice(0, 20).join(', ')}${drift.length > 20 ? ', ...' : ''}`
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
  const prefix = core.getInput('key-prefix') || 'sdk-e2e-model-v1'
  const concurrency = Number.parseInt(core.getInput('concurrency') || '4', 10)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got "${core.getInput('concurrency')}"`)
  }

  const plan = readPlan(planPath)
  if (mode === 'restore') {
    await restore(plan, planPath, prefix, concurrency, core.getBooleanInput('lookup-only'))
  } else if (mode === 'save') {
    await save(plan, planPath, prefix, concurrency, core.getBooleanInput('fail-on-save-error'))
  } else {
    throw new Error(`mode must be restore or save, got "${mode}"`)
  }
}

main().catch((error) => core.setFailed(message(error)))
