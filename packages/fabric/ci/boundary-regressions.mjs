// Build and exercise the registry port, including /MDd on Windows.
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join, delimiter, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(pkg, '../..')
const phase = process.argv[2]
if (!['build', 'test'].includes(phase)) {
  throw new Error('usage: boundary-regressions.mjs build|test')
}
if (!['linux', 'win32'].includes(process.platform)) throw new Error('Linux or Windows required')
const windows = process.platform === 'win32'
const toolchain = createRequire(join(root, '.github/bare-toolchain/package.json'))
const cmake = toolchain('cmake-runtime')('cmake')
const ctest = toolchain('cmake-runtime')('ctest')
const ninja = toolchain('ninja-runtime')()
// The npm launchers normally make unpacked runtime binaries executable.
for (const executable of [cmake, ctest, ninja]) {
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    chmodSync(executable, 0o755)
  }
}
const llvm = toolchain('llvm-runtime')
const toolchainFile = join(
  dirname(toolchain.resolve('cmake-toolchains/package')),
  `${windows ? 'win32' : 'linux'}-x64.cmake`
)
// vcpkg sanitizes PATH on Windows. Resolve executable shims before entering it,
// and forward the search paths its chainloaded toolchain needs to locate Node.
const programPaths = [...new Set([dirname(cmake), dirname(ninja), dirname(process.execPath)])]
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
const env = {
  ...process.env,
  [pathKey]: [...programPaths, process.env[pathKey]].filter(Boolean).join(delimiter),
  CMAKE_PROGRAM_PATH: [...programPaths, process.env.CMAKE_PROGRAM_PATH]
    .filter(Boolean)
    .join(delimiter),
  QVAC_BARE_MAKE_TOOLCHAIN_FILE: toolchainFile
}
const build = join(pkg, 'build/boundary-port')
const triplet = `boundary-x64-${windows ? 'windows' : 'linux'}`
const installed = join(build, 'vcpkg_installed', triplet)
const vcpkgRoot = process.env.VCPKG_ROOT
if (!vcpkgRoot) throw new Error('VCPKG_ROOT must name the provisioned vcpkg checkout')
function required(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: pkg, stdio: 'inherit', env, ...options })
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
    `--overlay-triplets=${build}`
  ])
  required(cmake, [
    '-S',
    join(pkg, 'test/native'),
    '-B',
    join(build, 'tests'),
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Debug',
    `-DCMAKE_MAKE_PROGRAM=${ninja}`,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
    '-DQVAC_TEST_REQUIRE_SHARED_CORE=ON',
    `-DCMAKE_C_COMPILER=${llvm(windows ? 'clang-cl' : 'clang')}`,
    `-DCMAKE_CXX_COMPILER=${llvm(windows ? 'clang-cl' : 'clang++')}`,
    `-DCMAKE_PREFIX_PATH=${installed}`,
    `-DQVAC_TEST_BACKEND=${join(installed, 'debug/lib', windows ? 'qvac-ggml-cpu-x64.dll' : 'libqvac-ggml-cpu-x64.so')}`,
    ...(windows
      ? []
      : [`-DQVAC_TEST_RUNTIME_PROVIDER=${join(installed, 'debug/lib/libqvac-ggml-base-1.so')}`])
  ])
  required(cmake, ['--build', join(build, 'tests'), '--parallel', '2'])
} else {
  if (!existsSync(join(build, 'tests/CMakeCache.txt'))) throw new Error('Run cpp:build first')
  required(
    ctest,
    [
      '--test-dir',
      join(build, 'tests'),
      '--output-on-failure',
      '--output-junit',
      'cpp-test-results.xml'
    ],
    {
      env: {
        ...env,
        [pathKey]: [join(installed, 'debug/bin'), env[pathKey]].join(delimiter)
      }
    }
  )
}
