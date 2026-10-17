import { promises as fsp } from 'node:fs'
import path from 'node:path'
import Bundle from 'bare-bundle'

// The JavaScript wrappers bare-stow writes around an encoded bundle.
const ENCODED_PREFIXES = ['module.exports = ', 'export default ']

/** The shim bare-stow writes beside `qvac/worker.entry.mjs`, which a bundle names as `main`. */
const ENTRY_SHIM = '/qvac/__main__.mjs'

export async function readBundle(bundlePath: string): Promise<Bundle> {
  const data = await fsp.readFile(bundlePath)

  for (const prefix of ENCODED_PREFIXES) {
    if (data.subarray(0, prefix.length).toString() === prefix) {
      return Bundle.from(JSON.parse(data.subarray(prefix.length).toString()) as string)
    }
  }

  return Bundle.from(data)
}

/**
 * The folder a bundle's module paths start from: the project root, or the
 * folder above it that holds an SDK from outside the project, which `main`
 * shows by naming the project's path below it.
 */
export function bundleRoot(main: string | null | undefined, projectRoot: string): string {
  if (!main?.endsWith(ENTRY_SHIM)) return projectRoot
  const depth = main.slice(0, -ENTRY_SHIM.length).split('/').filter(Boolean).length
  return path.resolve(projectRoot, ...Array<string>(depth).fill('..'))
}
