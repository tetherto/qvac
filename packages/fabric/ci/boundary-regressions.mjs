// Build and exercise the draft overlay port, including /MTd on Windows.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(pkg, '../..')
const phase = process.argv[2]
if (!['build', 'test'].includes(phase)) {
  throw new Error('usage: boundary-regressions.mjs build|test')
}
if (!['linux', 'win32'].includes(process.platform)) throw new Error('Linux or Windows required')
const windows = process.platform === 'win32'
const build = join(pkg, 'build/boundary-port')
const triplet = `boundary-x64-${windows ? 'windows' : 'linux'}`
const installed = join(build, 'vcpkg_installed', triplet)
const vcpkgRoot = process.env.VCPKG_ROOT
if (!vcpkgRoot) throw new Error('VCPKG_ROOT must name the provisioned vcpkg checkout')
function required(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: pkg, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`)
}
if (phase === 'build') {
  mkdirSync(build, { recursive: true })
  const base = join(
    root,
    'vcpkg-overlays/triplets',
    `x64-${windows ? 'windows' : 'linux'}.cmake`
  ).replaceAll('\\', '/')
  writeFileSync(join(build, `${triplet}.cmake`), `include("${base}")\nunset(VCPKG_BUILD_TYPE)\n`)
  required(join(vcpkgRoot, windows ? 'vcpkg.exe' : 'vcpkg'), [
    'install',
    `--triplet=${triplet}`,
    `--x-manifest-root=${join(pkg, 'test/native')}`,
    `--x-install-root=${join(build, 'vcpkg_installed')}`,
    `--overlay-ports=${join(root, 'vcpkg-overlays/ports')}`,
    `--overlay-triplets=${build}`
  ])
  required('cmake', [
    '-S',
    join(pkg, 'test/native'),
    '-B',
    join(build, 'tests'),
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Debug',
    '-DQVAC_TEST_REQUIRE_SHARED_CORE=ON',
    `-DCMAKE_C_COMPILER=${windows ? 'clang-cl' : 'clang'}`,
    `-DCMAKE_CXX_COMPILER=${windows ? 'clang-cl' : 'clang++'}`,
    `-DCMAKE_PREFIX_PATH=${installed}`,
    `-DQVAC_TEST_BACKEND=${join(installed, 'debug', windows ? 'bin/qvac-ggml-cpu-x64.dll' : 'lib/libqvac-ggml-cpu-x64.so')}`,
    ...(windows
      ? []
      : [`-DQVAC_TEST_RUNTIME_PROVIDER=${join(installed, 'debug/lib/libqvac-ggml-base-1.so')}`])
  ])
  required('cmake', ['--build', join(build, 'tests'), '--parallel', '2'])
} else {
  if (!existsSync(join(build, 'tests/CMakeCache.txt'))) throw new Error('Run cpp:build first')
  required(
    'ctest',
    [
      '--test-dir',
      join(build, 'tests'),
      '--output-on-failure',
      '--output-junit',
      'cpp-test-results.xml'
    ],
    {
      env: {
        ...process.env,
        PATH: [join(installed, 'debug/bin'), process.env.PATH].join(delimiter)
      }
    }
  )
}
