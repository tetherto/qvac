#!/usr/bin/env node
// The dual registry main's vla workflows set up before installing: @tetherto from GitHub Packages, @qvac from npmjs.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PKG } from './model-env.mjs'

export function npmrc({ NPM_TOKEN = '', GPR_TOKEN = '' }) {
  return [
    'registry=https://registry.npmjs.org/',
    '@qvac:registry=https://registry.npmjs.org/',
    '@tetherto:registry=https://npm.pkg.github.com/',
    `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`,
    `//npm.pkg.github.com/:_authToken=${GPR_TOKEN}`,
    ''
  ].join('\n')
}

// Windows set only the https rewrite; the other hosts also rewrote ssh remotes.
export function gitRewrites(token, platform) {
  const url = `https://${token}:@github.com/`
  return platform === 'win32'
    ? [[url, 'https://github.com/']]
    : [
        [url, 'https://github.com/'],
        [url, 'git@github.com:']
      ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  writeFileSync(join(PKG, '.npmrc'), npmrc(env))
  const token = env.GIT_PAT || env.GH_TOKEN
  if (token) {
    for (const [url, from] of gitRewrites(token, process.platform)) {
      execFileSync('git', ['config', '--global', `url.${url}.insteadOf`, from])
    }
  }
  console.log('Configured @tetherto on GitHub Packages and @qvac on npmjs')
}
