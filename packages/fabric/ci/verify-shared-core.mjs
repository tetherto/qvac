import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const host = process.argv[2]
if (!/^linux-(x64|arm64)$/.test(host || '')) throw new Error('Expected Linux host')
const overlay = resolve('../../vcpkg-overlays/ports/qvac-fabric').replaceAll('\\', '/')
const directory = resolve(`prebuilds/${host}/qvac__fabric-${host}`).replaceAll('\\', '/')
const temp = mkdtempSync(join(tmpdir(), 'qvac-core-check-'))
const script = join(temp, 'check.cmake')
writeFileSync(
  script,
  `
include("${overlay}/qvac-check-cxx-runtime.cmake")
include("${overlay}/qvac-check-shared-core.cmake")
file(GLOB modules "${directory}/libqvac-ggml-*.so")
qvac_check_shared_core(${process.argv.includes('--xdna') ? 'WITH_XDNA' : ''} \${modules})
find_program(READELF NAMES llvm-readelf readelf REQUIRED)
set(MODULE "${resolve(`prebuilds/${host}/qvac__fabric-${host}.bare`).replaceAll('\\', '/')}")
set(PROVIDER "${directory}/libqvac-ggml-base-1.so")
include("${resolve('../../cmake/qvac-addon/assert-fabric-cxx-runtime.cmake').replaceAll('\\', '/')}")
`
)
try {
  const result = spawnSync('cmake', ['-P', script], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Shared core validation failed (${result.status})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
