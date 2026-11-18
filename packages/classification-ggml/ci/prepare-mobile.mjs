#!/usr/bin/env node
// Copies the weights and images the React Native bundler packs into the app, and gives the Android build more heap.

import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })

// Advisory, as main ran it.
try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
sh('npm', ['run', 'mobile:copy-prebuilds'])
// Expo's metaspace limit stays; the heap grows for the GGUF fixtures. Read by the app build that follows.
if (process.env.PLATFORM === 'Android' && process.env.GITHUB_ENV)
  appendFileSync(
    process.env.GITHUB_ENV,
    'GRADLE_OPTS=-Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=512m"\n'
  )
