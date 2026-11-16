// What restore and save share: reading the plan, and looking an entry up without downloading it.
import * as cache from '@actions/cache'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { cacheKey, cachePaths, validatePlan } from './plan.mjs'

export const CONCURRENCY = 4
const LOOKUP_DELAY_MS = 20_000

export const label = (entry) => entry.models.join(',')
export const message = (error) => (error instanceof Error ? error.message : String(error))
export const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`
export const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)

export function readPlan(file) {
  try {
    return validatePlan(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`${file}: ${message(error)}`)
  }
}

export async function exists(entry, attempts = 1) {
  const [paths, key] = [cachePaths(entry), cacheKey(entry)]
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(LOOKUP_DELAY_MS)
    if (await cache.restoreCache(paths, key, [], { lookupOnly: true }, true)) return true
  }
  return false
}
