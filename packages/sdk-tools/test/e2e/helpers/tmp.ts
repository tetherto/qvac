import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

// Make a temp dir that is removed when the test finishes.
export async function tempDir(t: TestContext, prefix = 'qvac-cli-e2e-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}
