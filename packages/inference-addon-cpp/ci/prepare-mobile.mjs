#!/usr/bin/env node
// inference-addon-cpp's test:mobile, as its mobile workflow prepared it: the on-device suite generated from the desktop
// suites and checked, a host build and test of the mobile addon (Android leg, on Linux as main ran it), the addon built
// for the platform, and its directory handed to the app build as the package under test.

import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PKG, run } from './cpp.mjs'

const MOBILE = join(PKG, 'mobile')
export const PLATFORM_BUILD = {
  Android: ['--platform', 'android', '--arch', 'arm64', '-D', 'ANDROID_STL=c++_shared'],
  iOS: ['--platform', 'ios', '--arch', 'arm64']
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const flags = PLATFORM_BUILD[env.PLATFORM]
  if (!flags) throw new Error(`PLATFORM must be Android or iOS, got '${env.PLATFORM}'`)
  run('npm', ['install', '-g', '--force', 'bare', 'bare-make@1.8.0'], MOBILE, env)
  run('npm', ['install'], MOBILE, env)
  run('npm', ['run', 'test:mobile:generate'], MOBILE, env)
  run('npm', ['run', 'test:mobile:validate'], MOBILE, env)
  if (env.PLATFORM === 'Android') {
    for (const step of [['generate'], ['build'], ['install']]) run('bare-make', step, MOBILE, env)
    run('npm', ['test'], MOBILE, env)
  }
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
