#!/usr/bin/env node
// inference-addon-cpp's JS integration packages, as pr-test-inference-addon-cpp-js.yml ran them: each package under
// tests/integration_js is linted, built for the host with Bare's tooling and tested; --asan builds and runs under ASan.
//   node ci/integration-js.mjs [--asan]

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { PKG, pinnedCmake, run } from './cpp.mjs'

const sh = (cmd, args, cwd, env) =>
  spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
    .status === 0

// One package: true when every step passed.
export function testPackage(dir, { asan, env }) {
  const host = ['--platform', process.platform, '--arch', process.arch]
  if (!sh('npm', ['install', '--package-lock=false', '--ignore-scripts'], dir, env)) return false
  if (!sh('npm', ['run', 'lint'], dir, env)) return false
  let build = env
  let test = env
  if (asan) {
    rmSync(join(dir, 'build'), { recursive: true, force: true })
    rmSync(join(dir, 'prebuilds'), { recursive: true, force: true })
    build = {
      ...env,
      CXXFLAGS: '-fsanitize=address -fno-omit-frame-pointer',
      LDFLAGS: '-fsanitize=address'
    }
    const lib = spawnSync('cc', ['-print-file-name=libasan.so'], { encoding: 'utf8' }).stdout.trim()
    test = {
      ...env,
      LD_PRELOAD: lib,
      ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:alloc_dealloc_mismatch=0'
    }
  }
  return (
    sh('bare-make', ['generate', ...host], dir, build) &&
    sh('bare-make', ['build'], dir, build) &&
    sh('bare-make', ['install'], dir, build) &&
    sh('npm', ['test'], dir, test)
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { asan: { type: 'boolean', default: false } }
  })
  run('npm', ['install', '-g', '--force', 'bare', 'bare-make@1.8.0'], PKG, process.env)
  let env = pinnedCmake()
  if (process.platform === 'win32') {
    env = { ...env, CMAKE_GENERATOR: 'Visual Studio 17 2022', CMAKE_GENERATOR_PLATFORM: 'x64' }
  }
  const root = join(PKG, 'tests/integration_js')
  const failed = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (!existsSync(join(dir, 'package.json'))) continue
    console.log(`::group::${name}${values.asan ? ' ASAN' : ''}`)
    if (!testPackage(dir, { asan: values.asan, env })) failed.push(name)
    console.log('::endgroup::')
  }
  if (failed.length) {
    console.log(`::error::Failed JS integration packages: ${failed.join(' ')}`)
    process.exit(1)
  }
}
