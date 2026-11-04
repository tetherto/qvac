// Pure helpers for the cache action, free of @actions/* so they run under `node --test`.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function cacheKey(prefix, entry) {
  return `${prefix}-${entry.contentId}`
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

const SHA256 = /^[0-9a-f]{64}$/

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Same as contentIdOf in packages/sdk-e2e/runners/js/shared/model-cache-plan.ts. Recomputed so a
 * plan cannot save files under another model's key.
 */
export function contentIdFor(entry) {
  const [location] = entry.paths
  if (entry.files.length === 1 && entry.files[0].path === location) return entry.files[0].sha256
  const lines = entry.files.map((file) => `${file.path.slice(location.length)}:${file.sha256}`)
  return sha256Text(lines.sort().join('\n'))
}

function isPlanPath(candidate, root) {
  return (
    typeof candidate === 'string' &&
    candidate.startsWith(`${root}/`) &&
    !candidate.includes('\\') &&
    !candidate.split('/').includes('..')
  )
}

/** Reject a malformed plan: bad digests, paths outside the cache root, a wrong contentId. */
export function validatePlan(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.entries)) {
    throw new Error('not a version 1 model-cache plan')
  }
  const root = plan.cacheRoot
  if (
    typeof root !== 'string' ||
    root === '' ||
    path.isAbsolute(root) ||
    root.split('/').includes('..')
  ) {
    throw new Error(`cacheRoot must be a workspace-relative path, got ${JSON.stringify(root)}`)
  }
  if (!Array.isArray(plan.unresolved)) throw new Error('unresolved must be a list')
  for (const entry of plan.entries) {
    const name = Array.isArray(entry.models) ? entry.models.join(',') : '?'
    if (!SHA256.test(entry.contentId ?? '')) {
      throw new Error(`${name}: contentId must be a sha256 hex digest`)
    }
    if (!Array.isArray(entry.paths) || entry.paths.length !== 1) {
      throw new Error(`${name}: an entry has exactly one path, its file or its directory`)
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`${name}: files are required`)
    }
    for (const file of entry.files) {
      if (!SHA256.test(file.sha256 ?? '') || !Number.isInteger(file.size) || file.size < 0) {
        throw new Error(`${name}: ${file.path} needs a size and a sha256`)
      }
    }
    const all = [...entry.paths, ...entry.files.map((file) => file.path)]
    for (const candidate of all) {
      if (!isPlanPath(candidate, root)) {
        throw new Error(`${name}: ${JSON.stringify(candidate)} is not inside ${root}`)
      }
    }
    const [location] = entry.paths
    const single = entry.files.length === 1 && entry.files[0].path === location
    if (!single && !entry.files.every((file) => file.path.startsWith(`${location}/`))) {
      throw new Error(`${name}: files must be the entry's file or inside its directory`)
    }
    if (contentIdFor(entry) !== entry.contentId) {
      throw new Error(`${name}: contentId does not match the checksums of its files`)
    }
  }
  return plan
}

/**
 * Cache-root items no entry covers: after a bootstrap, drift between the plan and the SDK.
 * `sharded/` is never planned (the SDK writes an unpinned tensors file there), so it is skipped.
 */
export function unplannedPaths(plan, cwd = process.cwd()) {
  const covered = new Set(plan.entries.flatMap((entry) => entry.paths))
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
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

export function formatBytes(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`
}
