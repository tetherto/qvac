// No @actions/* imports: also used by scripts/model-cache-plan.mjs and the tests.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const KEY_PREFIX = 'sdk-e2e-model-v1'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** @qvac/inference's generateShortHash, which needs bare-crypto. */
export const shortHash = (text) => sha256(text).slice(0, 16)

/** One entry per cached path. contentId and file paths are the cache key and version. */
export function planEntries(cacheRoot, models) {
  const byPath = new Map()
  for (const { name, layout } of models) {
    const known = byPath.get(layout.path)
    if (known) {
      if (!known.models.includes(name)) known.models.push(name)
      continue
    }
    const single = layout.files.length === 1 && layout.files[0].path === layout.path
    byPath.set(layout.path, {
      contentId: single
        ? layout.files[0].sha256
        : sha256(
            layout.files
              .map((file) => `${file.path.slice(layout.path.length)}:${file.sha256}`)
              .sort()
              .join('\n')
          ),
      path: `${cacheRoot}/${layout.path}`,
      files: layout.files.map((file) => ({ ...file, path: `${cacheRoot}/${file.path}` })),
      size: layout.files.reduce((sum, file) => sum + file.size, 0),
      models: [name]
    })
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}

export function cacheKey(entry) {
  return `${KEY_PREFIX}-${entry.contentId}`
}

/** Exact files, not the directory, which actions/cache would tar whole. */
export function cachePaths(entry) {
  return entry.files.map((file) => file.path).sort()
}

/** Exact sizes: a truncated restore is not a hit. */
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

export async function firstChecksumMismatch(entry, cwd = process.cwd()) {
  for (const file of entry.files) {
    if ((await sha256File(path.resolve(cwd, file.path))) !== file.sha256) return file.path
  }
  return undefined
}

export function validatePlan(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.entries) || !Array.isArray(plan.unresolved)) {
    throw new Error('not a version 1 model-cache plan')
  }
  const root = plan.cacheRoot
  // A `\` would be a separator on Windows, past the `..` check.
  const unsafe = (value) => value.includes('\\') || value.split('/').includes('..')
  if (typeof root !== 'string' || !root || path.isAbsolute(root) || unsafe(root)) {
    throw new Error(`cacheRoot must be a workspace-relative path, got ${JSON.stringify(root)}`)
  }
  for (const entry of plan.entries) {
    for (const file of entry.files) {
      if (!file.path.startsWith(`${root}/`) || unsafe(file.path)) {
        throw new Error(`${JSON.stringify(file.path)} is not inside ${root}`)
      }
    }
  }
  return plan
}

/** Cache-root items no entry covers (plan/SDK drift). `sharded/` is never planned. */
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
