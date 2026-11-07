#!/usr/bin/env node
// Turns the built test app into a release APK with the JS bundle embedded.

import { appendFileSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function findApk(files) {
  return files.find((f) => f.endsWith('.apk') && f.includes('release') && !f.includes('unaligned'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = resolve(process.env.APP_DIR)
  const run = (cmd, args, cwd = app) => execFileSync(cmd, args, { stdio: 'inherit', cwd })
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean'])
  run('npm', ['run', 'bundle'])
  run(
    './gradlew',
    [
      'assembleRelease',
      '-PreactNativeArchitectures=arm64-v8a',
      '--no-daemon',
      '--no-build-cache',
      '--stacktrace'
    ],
    join(app, 'android')
  )
  const outputs = join(app, 'android/app/build/outputs/apk')
  const apk = findApk(readdirSync(outputs, { recursive: true }).map(String))
  if (!apk) throw new Error(`no release APK under ${outputs}`)
  // Gradle intermediates are most of the disk the job has left.
  rmSync(join(app, 'android/app/build/intermediates'), {
    recursive: true,
    force: true
  })
  rmSync(join(app, 'android/.gradle'), { recursive: true, force: true })
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `app-path=${join(outputs, apk)}\napp-type=ANDROID_APP\napp-name=test-app-Android.apk\n`
  )
}
