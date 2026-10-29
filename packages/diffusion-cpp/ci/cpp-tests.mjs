#!/usr/bin/env node
// diffusion's C++ test run, with the environment cpp-tests-nx.yml gave it: the SD2 model from the manifest at its
// absolute path, main's sanitizer options and bash as npm's script shell.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))

export function environment(base = process.env) {
  return {
    ...base,
    SD_TEST_MODEL_PATH: join(PKG, 'test/model/stable-diffusion-v2-1-Q8_0.gguf'),
    ASAN_OPTIONS: 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1',
    LSAN_OPTIONS: `suppressions=${join(PKG, '.lsan-suppressions.txt')}`,
    npm_config_script_shell: 'bash'
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = spawnSync('npm', ['run', 'test:cpp:run'], {
    cwd: PKG,
    env: environment(),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.error) throw r.error
  process.exit(r.status ?? 1)
}
