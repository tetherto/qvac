#!/usr/bin/env node
// publish-pypi.yml's checks around a tetherto-qvac-sdk release at @qvac/sdk's version: version [tag] (SDK_VERSION
// matches the SDK and the sdk-v<version> tag), wait-npm (npm serves @qvac/sdk at it) and wait-release <tag> (the GitHub
// release exists), the last two being what publish-npm.yml does first.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const read = (path) => readFileSync(`${root}${path}`, 'utf8')
const sdkVersion = () => JSON.parse(read('packages/sdk/package.json')).version
const pyVersion = () =>
  read('packages/sdk-python/src/tetherto/qvac_sdk/_generated/sdk_version.py').match(
    /^SDK_VERSION = "(.*)"$/m
  )?.[1]

function version([tag]) {
  const py = pyVersion()
  const sdk = sdkVersion()
  if (!py) throw new Error('could not parse SDK_VERSION from sdk_version.py')
  if (py !== sdk)
    throw new Error(
      `tetherto-qvac-sdk@${py} vs @qvac/sdk@${sdk}: run packages/sdk-python/scripts/generate.py before release`
    )
  if (tag && tag.replace(/^sdk-v/, '') !== py)
    throw new Error(`tetherto-qvac-sdk ${py} does not match the tag ${tag}`)
  console.log(`tetherto-qvac-sdk and @qvac/sdk both at ${py}${tag ? `, matching ${tag}` : ''}`)
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
