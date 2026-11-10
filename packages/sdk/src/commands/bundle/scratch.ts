import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** A scratch folder `next`, ready to replace `dir`. */
export interface Staged {
  dir: string
  next: string
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
    for (const entry of replaced.reverse()) await putBack(entry)
    throw error
  }
}

function previousOf(next: string) {
  return path.join(path.dirname(next), 'previous')
}

/** Moves `next` to `dir`, and `dir`'s old content into `next`'s scratch folder. */
async function replaceWith({ dir, next }: Staged) {
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
    if (moved) await fsp.rename(previousOf(next), dir)
    throw error
  }
}

async function putBack({ dir, next }: Staged) {
  await fsp.rename(dir, next)
  try {
    await fsp.rename(previousOf(next), dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
