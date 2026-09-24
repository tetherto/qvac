import os from 'bare-os'
import path from 'bare-path'
import { getConfiguredCacheDir, isConfigSet, setConfig } from '@/runtime/state'
import { isPathWithinBase } from '@/utils/path-security'

// Every test file shares one process and `setConfig` only runs once, so all
// files must agree on a single cache directory.
export const TEST_CACHE_DIR = path.join(os.tmpdir(), `qvac-inference-test-cache-${os.pid()}`)

// Returns the cache directory actually in use. Refuses anything outside the
// temp dir so a test's cleanup can never wipe a real model cache.
export function useTestCacheDir(): string {
  if (!isConfigSet()) setConfig({ cacheDirectory: TEST_CACHE_DIR, loggerConsoleOutput: false })
  const dir = getConfiguredCacheDir()
  if (!isPathWithinBase(os.tmpdir(), dir)) {
    throw new Error(`test cache directory is outside the temp dir: ${dir}`)
  }
  return dir
}
