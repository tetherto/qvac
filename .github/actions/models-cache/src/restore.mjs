// Restores a package's models, never saves them: every PR leg runs this, and only cache-warm.yml saves.
// mode all restores the package's one entry; per-model restores each entry the plan lists, by its content.
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import { cacheKey, cachePaths, isComplete, mapWithConcurrency } from './plan.mjs'
import { CONCURRENCY, exists, gigabytes, label, lines, message, readPlan } from './common.mjs'

async function restoreEntry(entry, lookupOnly) {
  if (lookupOnly) return exists(entry)
  const key = cacheKey(entry)
  if (!(await cache.restoreCache(cachePaths(entry), key, [], {}, true))) return false
  if (isComplete(entry)) return true
  core.warning(`Restored ${label(entry)} is incomplete; if this repeats: gh cache delete ${key}`)
  return false
}

async function perModel(plan, lookupOnly) {
  const started = Date.now()
  const hits = await mapWithConcurrency(plan.entries, CONCURRENCY, (entry) =>
    restoreEntry(entry, lookupOnly).catch((error) => {
      core.warning(`Restore of ${label(entry)} failed: ${message(error)}`)
      return false
    })
  )
  const restored = plan.entries.filter((_, i) => hits[i])
  const missing = [...plan.entries.filter((_, i) => !hits[i]).flatMap((e) => e.models), ...plan.unresolved]
  core.info(
    `📦 ${restored.length}/${plan.entries.length} model(s) ${lookupOnly ? 'present' : 'restored'} ` +
      `(${gigabytes(restored.reduce((sum, e) => sum + e.size, 0))}) in ` +
      `${Math.round((Date.now() - started) / 1000)}s; ${missing.length} to download`
  )
  for (const name of missing) core.info(`   to download: ${name}`)
  core.setOutput('cache-hit', String(missing.length === 0))
  core.setOutput('missing-models', JSON.stringify(missing))
}

async function all(paths, key, restoreKeys) {
  const hit = await cache.restoreCache(paths, key, restoreKeys, {}, true)
  core.info(hit ? `Restored ${hit}` : `No entry for ${key}`)
  core.setOutput('cache-hit', String(hit === key))
  core.setOutput('missing-models', '[]')
}

async function main() {
  const mode = core.getInput('mode') || 'all'
  if (mode === 'per-model') {
    // A plan a package's own code wrote names only what to restore, and only under the root the trusted step set.
    const plan = readPlan(core.getInput('plan', { required: true }))
    const root = core.getInput('cache-root')
    if (root && plan.cacheRoot !== root) throw new Error(`plan cacheRoot ${plan.cacheRoot} is not ${root}`)
    await perModel(plan, core.getBooleanInput('lookup-only'))
  }
  else if (mode === 'all')
    await all(lines(core.getInput('paths', { required: true })), core.getInput('key', { required: true }), lines(core.getInput('restore-keys')))
  else throw new Error(`mode must be all or per-model, got "${mode}"`)
}

main().catch((error) => core.setFailed(message(error)))
