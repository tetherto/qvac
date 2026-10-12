import { attach } from 'bare-stow/runtime'
import { pathToFileURL } from 'bare-url'
import type { Duplex } from 'bare-stream'

/** bare-stow's worker runtime over `medium`, around the entry at `entryPath`. */
export function runEntry(medium: Duplex, entryPath: string): Promise<void> {
  const ipc = attach(medium)
  return ipc.run(() => import(pathToFileURL(entryPath).href), ipc)
}
