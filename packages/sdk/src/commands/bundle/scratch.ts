import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

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
  return path.join(owned, path.basename(dir))
}

export async function discardScratch(scratch: string) {
  await fsp.rm(path.dirname(scratch), { recursive: true, force: true })
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

function previousOf(next: string) {
  return path.join(path.dirname(next), 'previous')
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
  await fsp.rename(entry.dir, entry.next)
  await restorePrevious(entry, cause)
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await fsp.access(previous)
      } catch {
        return
      }
    }
    entry.kept = previous
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Could not replace ${entry.dir} (${reason}), nor move its previous content back ` +
        `(${error instanceof Error ? error.message : String(error)}). The previous content is in ${previous}.`,
      { cause }
    )
  }
}
