#!/usr/bin/env node
// inference-addon-cpp's test:mobile, as its mobile workflow prepared it: the on-device suite generated from the desktop
// suites and checked, a host build and test of the mobile addon (Android leg, on Linux as main ran it), the addon built
// for the platform, and its directory handed to the app build as the package under test.

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PKG, run } from './cpp.mjs'

const MOBILE = join(PKG, 'mobile')
// main's setup-build-host for the Android prebuild: the pinned NDK in every selector, Bare's included, its toolchain
// variables and the Ubuntu cross packages.
export function androidEnv(env, toolchain) {
  const ndk = join(env.ANDROID_HOME ?? '', 'ndk', toolchain.ndk)
  if (!existsSync(join(ndk, 'source.properties'))) {
    const sdkmanager = join(env.ANDROID_HOME ?? '', 'cmdline-tools/latest/bin/sdkmanager')
    run(sdkmanager, ['--install', `ndk;${toolchain.ndk}`], PKG, env)
  }
  run(
    'sh',
    ['-c', `sudo apt-get update && sudo apt-get install -y ${toolchain.aptPackages}`],
    PKG,
    env
  )
  return {
    ...env,
    ANDROID_NDK: ndk,
    ANDROID_NDK_HOME: ndk,
    ANDROID_NDK_ROOT: ndk,
    ANDROID_NDK_LATEST_HOME: ndk,
    ANDROID_TOOLCHAIN_ROOT: `${ndk}/toolchains/llvm/prebuilt/linux-x86_64`,
    ANDROID_NATIVE_API_LEVEL: toolchain.apiLevel
  }
}

export const PLATFORM_BUILD = {
  Android: ['--platform', 'android', '--arch', 'arm64', '-D', 'ANDROID_STL=c++_shared'],
  iOS: ['--platform', 'ios', '--arch', 'arm64']
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env
  const flags = PLATFORM_BUILD[host.PLATFORM]
  if (!flags) throw new Error(`PLATFORM must be Android or iOS, got '${host.PLATFORM}'`)
  run('npm', ['install', '-g', '--force', 'bare', 'bare-make@1.8.0'], MOBILE, host)
  run('npm', ['install'], MOBILE, host)
  run('npm', ['run', 'test:mobile:generate'], MOBILE, host)
  run('npm', ['run', 'test:mobile:validate'], MOBILE, host)
  if (host.PLATFORM === 'Android') {
    for (const step of [['generate'], ['build'], ['install']]) run('bare-make', step, MOBILE, host)
    run('npm', ['test'], MOBILE, host)
  }
  const nx = JSON.parse(readFileSync(join(PKG, '../../nx.json'), 'utf8'))
  const env =
    host.PLATFORM === 'Android'
      ? androidEnv(host, nx.targetDefaults.build.metadata.toolchain.android)
      : host
  rmSync(join(MOBILE, 'build'), { recursive: true, force: true })
  rmSync(join(MOBILE, 'prebuilds'), { recursive: true, force: true })
  run('bare-make', ['generate', ...flags], MOBILE, env)
  run('bare-make', ['build'], MOBILE, env)
  run('bare-make', ['install'], MOBILE, env)
  const addon = join(
    MOBILE,
    'prebuilds',
    `${flags[1]}-arm64`,
    'inference-addon-cpp-mobile-tests.bare'
  )
  if (!existsSync(addon)) throw new Error(`the ${env.PLATFORM} build left no ${addon}`)
  run('npm', ['run', 'mobile:copy-prebuilds'], MOBILE, env)
  appendFileSync(env.GITHUB_OUTPUT, `workdir=${MOBILE}\n`)
}
