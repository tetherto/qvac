// Pure helpers for the cache action, free of @actions/* so they run under `node --test`.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const KEY_PREFIX = 'sdk-e2e-model-v1'

export function cacheKey(entry) {
  return `${KEY_PREFIX}-${entry.contentId}`
}

/**
 * The entry's exact files, sorted. Not the directory: actions/cache would tar it whole, `!`
 * exclusions included. The cache version hashes this list, so restore and save must match.
 */
export function cachePaths(entry) {
  return entry.files.map((file) => file.path).sort()
}

/** Every file on disk at its exact size, so a truncated restore is not a hit. */
export function isComplete(entry, cwd = process.cwd()) {
  return entry.files.every((file) => {
    try {
      const stat = fs.statSync(path.resolve(cwd, file.path))
      return stat.isFile() && stat.size === file.size
    } catch {
      return false
    }
  })
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** The first file whose sha256 is not the registry's, or `undefined`. */
export async function firstChecksumMismatch(entry, cwd = process.cwd()) {
  for (const file of entry.files) {
    if ((await sha256File(path.resolve(cwd, file.path))) !== file.sha256) return file.path
  }
  return undefined
}

/** Reject a plan from another schema, or one that would write outside the cache root. */
export function validatePlan(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.entries) || !Array.isArray(plan.unresolved)) {
    throw new Error('not a version 1 model-cache plan')
  }
  const root = plan.cacheRoot
  if (typeof root !== 'string' || !root || path.isAbsolute(root) || root.includes('..')) {
    throw new Error(`cacheRoot must be a workspace-relative path, got ${JSON.stringify(root)}`)
  }
  for (const entry of plan.entries) {
    for (const file of entry.files) {
      if (!file.path.startsWith(`${root}/`) || file.path.split('/').includes('..')) {
        throw new Error(`${JSON.stringify(file.path)} is not inside ${root}`)
      }
    }
  }
  return plan
}

/**
 * Cache-root items no entry covers: after a bootstrap, drift between the plan and the SDK.
 * `sharded/` is never planned (getModelCacheLayout leaves sharded models out), so it is skipped.
 */
export function unplannedPaths(plan, cwd = process.cwd()) {
  const covered = new Set(plan.entries.map((entry) => entry.path))
  const root = plan.cacheRoot
  const found = []
  const list = (relative) => {
    try {
      return fs.readdirSync(path.resolve(cwd, relative)).sort()
    } catch {
      return []
    }
  }
  for (const name of list(root)) {
    const relative = `${root}/${name}`
    if (name === 'sharded') continue
    if (name === 'sets') {
      for (const inner of list(relative)) {
        if (!covered.has(`${relative}/${inner}`)) found.push(`${relative}/${inner}`)
      }
    } else if (!name.startsWith('.') && !covered.has(relative)) {
      found.push(relative)
    }
  }
  return found
}

/** `worker` over `items`, at most `limit` at a time, results in input order. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}
