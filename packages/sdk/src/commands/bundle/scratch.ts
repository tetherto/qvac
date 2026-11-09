import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** The file in each scratch folder that names the process that made it. */
export const SCRATCH_OWNER_FILE = 'owner.pid'

/** A scratch folder `next`, ready to replace `dir`. */
export interface Staged {
  dir: string
  next: string
  /**
   * Set by `replaceAll` when `dir`'s old content could not be moved back: the
   * path in `next`'s scratch folder that still holds it. `discardStaged` keeps
   * that scratch folder.
   */
  kept?: string
}

/**
 * A new folder with `dir`'s name, inside a folder of its own next to `dir`, so
 * what bare-stow writes there is named as it would be in `dir`. `discardScratch`
 * removes it.
 */
export async function scratchFolderFor(dir: string): Promise<string> {
  const owned = path.join(path.dirname(dir), `.${path.basename(dir)}-${randomUUID()}`)
  await fsp.mkdir(owned, { recursive: true })
  await fsp.writeFile(path.join(owned, SCRATCH_OWNER_FILE), String(process.pid))
  return path.join(owned, path.basename(dir))
}

export async function discardScratch(scratch: string) {
  await fsp.rm(path.dirname(scratch), { recursive: true, force: true })
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Removes the scratch folders `scratchFolderFor(dir)` made in runs that never
 * discarded them, such as a killed one. A folder whose process is still running
 * belongs to a bundle in progress, and one that holds `dir`'s old content may
 * hold the only copy left, so both stay.
 */
export async function removeStaleScratch(dir: string) {
  const parent = path.dirname(dir)
  const name = path.basename(dir)
  const pattern = new RegExp(`^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${UUID}$`)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue
    const owned = path.join(parent, entry)
    if (await ownerRunning(owned)) continue
    if (await exists(previousOf(path.join(owned, name)))) continue
    await fsp.rm(owned, { recursive: true, force: true })
  }
}

async function ownerRunning(owned: string) {
  let pid: number
  try {
    pid = Number.parseInt(await fsp.readFile(path.join(owned, SCRATCH_OWNER_FILE), 'utf8'), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function exists(file: string) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** Discards the scratch folder of each staged folder, except one that holds kept content. */
export async function discardStaged(staged: Staged[]) {
  for (const entry of staged) {
    if (entry.kept === undefined) await discardScratch(entry.next)
  }
}

/**
 * Moves every staged folder into place, or none: when a move fails, the folders
 * already moved go back to their scratch folders and their old content returns.
 */
export async function replaceAll(staged: Staged[]) {
  const replaced: Staged[] = []
  try {
    for (const entry of staged) {
      await replaceWith(entry)
      replaced.push(entry)
    }
  } catch (error) {
    let failure = error
    for (const entry of replaced.reverse()) {
      try {
        await putBack(entry, error)
      } catch (putBackError) {
        failure = putBackError
      }
    }
    throw failure
  }
}

/** Where `replaceAll` keeps `dir`'s old content: beside `next`, under a name `next` cannot have. */
function previousOf(next: string) {
  return `${next}.previous`
}

/** Moves `next` to `dir`, and `dir`'s old content into `next`'s scratch folder. */
async function replaceWith(entry: Staged) {
  const { dir, next } = entry
  let moved = true
  try {
    await fsp.rename(dir, previousOf(next))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    moved = false
  }
  try {
    await fsp.rename(next, dir)
  } catch (error) {
    if (moved) await restorePrevious(entry, error)
    throw error
  }
}

async function putBack(entry: Staged, cause: unknown) {
  try {
    await fsp.rename(entry.dir, entry.next)
  } catch (error) {
    const previous = previousOf(entry.next)
    if (!(await exists(previous))) throw error
    entry.kept = previous
    throw new Error(
      `Could not move ${entry.dir} back after a failed replace (${errorMessage(error)}). ` +
        `Its previous content is in ${previous}.`,
      { cause }
    )
  }
  await restorePrevious(entry, cause)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Moves `dir`'s old content back from `next`'s scratch folder. When that fails,
 * marks the entry kept and throws an error naming where the content is.
 */
async function restorePrevious(entry: Staged, cause: unknown) {
  const previous = previousOf(entry.next)
  try {
    await fsp.rename(previous, entry.dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !(await exists(previous))) return
    entry.kept = previous
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Could not replace ${entry.dir} (${reason}), nor move its previous content back ` +
        `(${error instanceof Error ? error.message : String(error)}). The previous content is in ${previous}.`,
      { cause }
    )
  }
}
