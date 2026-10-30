#!/usr/bin/env node
// cli's publish target: on GitHub Packages the CLI runs as @tetherto/cli-mono against @tetherto/sdk-mono, with the
// tetherto bin and program name, as main's cli-rewrite-sdk-scope-for-gpr action rewrote it before publishing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.PUBLISH_REGISTRY !== 'gpr') process.exit(0)
const cli = fileURLToPath(new URL('..', import.meta.url))
const SDK = '@tetherto/sdk-mono'
const CLI = '@tetherto/cli-mono'
const rewrites = {
  'src/bundle-sdk/constants.js': [['@qvac/sdk', SDK]],
  'src/bundle-sdk/index.js': [
    ["'@qvac'", "'@tetherto'"],
    ["'sdk'", "'sdk-mono'"],
    ['@qvac/sdk', SDK]
  ],
  'package.json': [['"qvac": "./src/index.js"', '"tetherto": "./src/index.js"']],
  'src/index.js': [[".name('qvac')", ".name('tetherto')"]],
  'src/errors.js': [['@qvac/cli', CLI]],
  'src/bundle-sdk/entry-gen.js': [['npx qvac', 'npx tetherto']]
}
for (const [file, pairs] of Object.entries(rewrites)) {
  const path = join(cli, file)
  if (!existsSync(path)) continue
  let text = readFileSync(path, 'utf8')
  for (const [from, to] of pairs) text = text.replaceAll(from, to)
  writeFileSync(path, text)
  console.log(`Updated ${file}`)
}
