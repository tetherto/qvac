#!/usr/bin/env node
// The sdk's publish target: prepares the built package for the registry publish-gpr.yml sends it to. On GitHub
// Packages, when @qvac/inference publishes in the same run, @qvac/inference becomes an npm alias of that run's
// @tetherto/inference-mono, so the -mono SDK runs the engine it was compiled against, as main's dev builds pinned it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { distTag, publishVersion } from '../../../.github/actions/gpr-publish/gpr-publish.mjs'

const sdk = fileURLToPath(new URL('..', import.meta.url))
const env = process.env
if (env.PUBLISH_REGISTRY !== 'gpr') process.exit(0)
// The committed manifest: sdk-source:workspace, which built this dist, pointed @qvac/inference at the checkout.
execFileSync('git', ['checkout', 'HEAD', '--', 'package.json'], { cwd: sdk, stdio: 'inherit' })

// Main's dormant rewrites for the -mono name: neither file exists at these paths today.
const name = '@tetherto/sdk-mono'
for (const [file, pairs] of [
  [
    'expo/plugins/withMobileBundle.ts',
    [
      ['"@qvac"', '"@tetherto"'],
      ['"cli"', '"cli-mono"'],
      ['@qvac/cli', '@tetherto/cli-mono'],
      ['npx qvac', 'npx tetherto']
    ]
  ],
  ['client/rpc/expo-rpc-client.ts', [['@qvac/sdk', name]]]
]) {
  const path = join(sdk, file)
  if (!existsSync(path)) continue
  let text = readFileSync(path, 'utf8')
  for (const [from, to] of pairs) text = text.replaceAll(from, to)
  writeFileSync(path, text)
  console.log(`Rewrote ${file} for ${name}`)
}

const projects = JSON.parse(env.PUBLISH_PROJECTS || '[]')
if (!projects.includes('@qvac/inference')) {
  console.log('@qvac/inference does not publish in this run; the committed range stays')
  process.exit(0)
}
const inference = JSON.parse(readFileSync(join(sdk, '..', 'inference', 'package.json'), 'utf8'))
const tag = distTag({
  tag: env.PUBLISH_TAG,
  event: env.GITHUB_EVENT_NAME,
  refName: env.GITHUB_REF_NAME
})
const version = publishVersion({ version: inference.version, tag, runId: env.GITHUB_RUN_ID })
const manifestPath = join(sdk, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies['@qvac/inference'] = `npm:@tetherto/inference-mono@${version}`
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Pinned @qvac/inference -> ${manifest.dependencies['@qvac/inference']}`)
