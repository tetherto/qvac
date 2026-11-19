// The source is pinned to the locally reproduced baseline. Both layouts are
// built and tested; a failing static baseline never skips the shared control.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const revision = '8d2d538e1220ad26e17ddcdf481830ec53f56fbf'
const source = resolve(process.env.QVAC_GGML_BOUNDARY_SOURCE || join(pkg, 'build/boundary-source'))
const phase = process.argv[2]
if (!['build', 'test'].includes(phase)) {
  throw new Error('usage: boundary-regressions.mjs build|test')
}
if (!['linux', 'win32'].includes(process.platform)) {
  throw new Error('Boundary CI supports Linux and Windows')
}

function run(command, args, options = {}) {
  // Avoid npm's .cmd shims on Windows; these tools all ship native executables.
  const executable = process.platform === 'win32' ? command + '.exe' : command
  const result = spawnSync(executable, args, { cwd: pkg, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  return result
}
function required(command, args, options) {
  const result = run(command, args, options)
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`)
  return result
}

if (phase === 'build') {
  if (!existsSync(join(source, '.git'))) {
    if (process.env.QVAC_GGML_BOUNDARY_SOURCE) {
      throw new Error('Source override must be a git checkout')
    }
    mkdirSync(source, { recursive: true })
    required('git', ['init', source])
    required('git', [
      '-C',
      source,
      'fetch',
      '--depth=1',
      'https://github.com/tetherto/qvac-fabric-llm.cpp.git',
      revision
    ])
    required('git', ['-C', source, 'checkout', '--detach', revision])
  }
  const head = required('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: 'pipe'
  }).stdout.trim()
  if (head !== revision) throw new Error(`Expected source ${revision}, found ${head}`)
  required('git', ['-C', source, 'diff', '--exit-code', 'HEAD', '--', 'ggml'])
  for (const shared of ['OFF', 'ON']) {
    const build = join(pkg, 'build', shared === 'ON' ? 'boundary-shared' : 'boundary-static')
    const args = [
      '-S',
      join(pkg, 'test/native'),
      '-B',
      build,
      `-DQVAC_GGML_SOURCE_DIR=${join(source, 'ggml')}`,
      `-DBUILD_SHARED_LIBS=${shared}`,
      '-DCMAKE_BUILD_TYPE=Debug'
    ]
    if (process.platform === 'win32') args.push('-G', 'Visual Studio 17 2022', '-A', 'x64')
    else args.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=clang', '-DCMAKE_CXX_COMPILER=clang++')
    required('cmake', args)
    required('cmake', ['--build', build, '--config', 'Debug', '--parallel', '2'])
  }
} else {
  const results = []
  for (const layout of ['static', 'shared']) {
    const build = join(pkg, 'build', `boundary-${layout}`)
    if (!existsSync(join(build, 'CMakeCache.txt'))) throw new Error(`Run cpp:build first: ${build}`)
    const result = run('ctest', [
      '--test-dir',
      build,
      '-C',
      'Debug',
      '--output-on-failure',
      '--output-junit',
      'cpp-test-results.xml'
    ])
    results.push({ layout, status: result.status, signal: result.signal })
  }
  writeFileSync(
    join(pkg, 'build/boundary-results.json'),
    JSON.stringify({ revision, results }, null, 2) + '\n'
  )
  console.log(JSON.stringify({ revision, results }, null, 2))
  process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0
}
