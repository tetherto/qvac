#!/usr/bin/env node
// publish-pypi.yml's checks around a tetherto-qvac-sdk release, which takes @qvac/sdk's version: version [tag] (that
// version matches the sdk-v<version> tag), wait-npm (npm serves @qvac/sdk at it) and wait-release <tag> (the GitHub
// release exists), the last two being what publish-npm.yml does first.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const sdkVersion = () =>
  JSON.parse(readFileSync(`${root}packages/sdk/package.json`, 'utf8')).version

function version([tag]) {
  const sdk = sdkVersion()
  if (tag && tag.replace(/^sdk-v/, '') !== sdk)
    throw new Error(`tetherto-qvac-sdk ${sdk} does not match the tag ${tag}`)
  console.log(`tetherto-qvac-sdk at @qvac/sdk's ${sdk}${tag ? `, matching ${tag}` : ''}`)
}

// 30 minutes, every 30 seconds: the two publishes start from the same push.
async function waitFor(what, probe) {
  for (let i = 0; i < 60; i++) {
    try {
      probe()
      console.log(`${what}: found`)
      return
    } catch {
      console.log(`${what}: not yet (${i + 1}/60)`)
      await new Promise((ok) => setTimeout(ok, 30_000))
    }
  }
  throw new Error(`${what}: not found after 30 minutes; publish-npm.yml did not publish it`)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'version') version(args)
else if (command === 'wait-npm') {
  const v = sdkVersion()
  await waitFor(`@qvac/sdk@${v} on npm`, () => {
    if (
      execFileSync('npm', ['view', `@qvac/sdk@${v}`, 'version'], { encoding: 'utf8' }).trim() !== v
    )
      throw new Error('missing')
  })
} else if (command === 'wait-release')
  await waitFor(`GitHub release ${args[0]}`, () =>
    execFileSync('gh', ['release', 'view', args[0], '--repo', process.env.GITHUB_REPOSITORY], {
      stdio: 'ignore'
    })
  )
else throw new Error('usage: release.mjs version [tag] | wait-npm | wait-release <tag>')
