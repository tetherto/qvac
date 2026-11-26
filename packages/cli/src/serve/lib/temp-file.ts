import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const PRIVATE_DIR_PREFIX = 'qvac-serve-'

// Each upload gets its own owner-only directory, so other local users can't
// read it or pre-plant a file or symlink at a predictable path.
export async function writePrivateTempFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), PRIVATE_DIR_PREFIX))
  const path = join(dir, name)
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  return path
}

// Removes a file written by writePrivateTempFile together with its directory.
// Never throws, so callers can use it in a finally block.
export async function removePrivateTempFile(path: string): Promise<void> {
  const dir = dirname(path)
  if (!basename(dir).startsWith(PRIVATE_DIR_PREFIX)) return
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
