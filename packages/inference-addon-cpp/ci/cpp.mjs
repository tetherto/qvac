#!/usr/bin/env node
// inference-addon-cpp's C++ tests, as main's C++ test workflow ran them: the CMake preset with tests on
// (build), then ctest and the Debug build (test). Windows takes the CMake 3.31.6 main pinned there.
//   node ci/cpp.mjs build|test [--platform=android]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const PKG = fileURLToPath(new URL('..', import.meta.url))
export const CMAKE_VERSION = '3.31.6'

// PATH with dir in front, under whichever spelling of the name the platform uses.
export function prependPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: [dir, env[key]].filter(Boolean).join(delimiter) }
}

// Windows' CMake, downloaded once per runner temp directory, as main's workflows put it on PATH.
export function pinnedCmake(env = process.env) {
  if (process.platform !== 'win32') return env
  const name = `cmake-${CMAKE_VERSION}-windows-x86_64`
  const root = join(env.RUNNER_TEMP ?? PKG, 'cmake')
  if (!existsSync(join(root, name, 'bin'))) {
    mkdirSync(root, { recursive: true })
    const url = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/${name}.zip`
    run('curl', ['-fsSL', '--retry', '3', url, '-o', join(root, `${name}.zip`)], root, env)
    // Expand-Archive as main did: the tar first on the runner's PATH may be GNU tar, which cannot read a zip.
    run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${name}.zip' -DestinationPath . -Force`
      ],
      root,
      env
    )
  }
  return prependPath(env, join(root, name, 'bin'))
}

export function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.error) throw r.error
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: { platform: { type: 'string', default: '' } },
    allowPositionals: true
  })
  let env = pinnedCmake()
  // The cross-compile variables main set on its android leg; the preset builds for the host either way.
  if (values.platform === 'android') {
    env = {
      ...env,
      ANDROID_TOOLCHAIN_ROOT: `${env.ANDROID_NDK_HOME ?? ''}/toolchains/llvm/prebuilt/linux-x86_64`,
      ANDROID_NATIVE_API_LEVEL: '34'
    }
  }
  const configure = ['--preset', 'default', '-D', 'BUILD_TESTING=ON', '-S', '.', '-B', 'build']
  if (positionals[0] === 'build') {
    run('cmake', configure, PKG, env)
    run('cmake', ['--build', 'build'], PKG, env)
  } else if (positionals[0] === 'test') {
    run(
      'ctest',
      ['--rerun-failed', '--output-on-failure', '--timeout', '35'],
      join(PKG, 'build'),
      env
    )
    run('cmake', [...configure, '-D', 'CMAKE_BUILD_TYPE=Debug'], PKG, env)
    run('cmake', ['--build', 'build'], PKG, env)
  } else {
    throw new Error('usage: node ci/cpp.mjs build|test [--platform=android]')
  }
}
