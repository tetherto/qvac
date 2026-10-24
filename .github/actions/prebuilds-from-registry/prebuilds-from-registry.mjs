#!/usr/bin/env node
// Installs a published build's prebuilds: @qvac from npmjs, @tetherto -mono dev builds from GitHub Packages.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SPEC = /^(@(qvac|tetherto)\/)?[a-z0-9][a-z0-9._-]*(@[~^]?[A-Za-z0-9][A-Za-z0-9._+-]*)?$/
const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?$/

// The host itself, not a prefix: https://npm.pkg.github.com.evil.example would pass a startsWith.
export function isGprRegistry(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.host === 'npm.pkg.github.com'
  } catch {
    return false
  }
}

export function specFor(pkg, addon) {
  if (/^@[^/]+\//.test(pkg)) return pkg
  return `${addon}@${pkg || 'latest'}`
}

// git, file and https specs would run prepare scripts in a step holding a registry token.
export const isRegistrySpec = (spec) => SPEC.test(spec)
export const isExact = (v) => EXACT.test(v)
export const nameOf = (spec) =>
  spec.replace(/^@[^/]+\//, '').includes('@') ? spec.slice(0, spec.lastIndexOf('@')) : spec
export const addonOf = (name) =>
  name
    .split('/')
    .pop()
    .replace(/-mono$/, '')

// The registry-controlled map may only confirm the slice name the slicer writes.
export function sliceFor(manifest, platform) {
  const suffix = { iOS: 'ios', Android: 'android-arm64' }[platform]
  if (!suffix) throw new Error(`no per-platform package for platform ${platform}`)
  const map = (manifest.imports || {})['#host-addon'] || {}
  const mapped = suffix === 'ios' ? map.ios : (map.android || {}).arm64
  const expected = `${manifest.name}-${suffix}`
  if (mapped !== expected)
    throw new Error(
      `${manifest.name}@${manifest.version} ships no prebuilds/ and its #host-addon map does not name ${expected} (got '${mapped || 'nothing'}')`
    )
  if (!isExact(manifest.version))
    throw new Error(
      `${manifest.name} resolved to '${manifest.version}', which is not an exact version`
    )
  return `${expected}@${manifest.version}`
}

function packOne(spec, dest, { packDir, run }) {
  mkdirSync(dest, { recursive: true })
  run('npm', ['pack', spec, '--ignore-scripts', '--pack-destination', dest], {
    cwd: packDir
  })
  const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'))
  run('tar', ['-xzf', join(dest, tgz), '-C', dest])
  return JSON.parse(readFileSync(join(dest, 'package/package.json'), 'utf8'))
}

export function packPrebuilds({ workdir, pkg, addon, platform, pinned, token, tmp, run }) {
  const out = join(workdir, 'prebuilds')
  if (existsSync(out) && readdirSync(out).length) {
    if (!pinned) return console.log('prebuilds/ already present, nothing to pack')
    rmSync(out, { recursive: true, force: true })
  }
  const spec = specFor(pkg, addon)
  if (!isRegistrySpec(spec))
    throw new Error(
      `refusing to npm pack '${spec}': expected @qvac/<addon>@<version> or @tetherto/<addon>-mono@<version>`
    )
  const name = nameOf(spec)
  const gpr = spec.startsWith('@tetherto/')
  const packDir = join(tmp, 'gpr-prebuild-pack')
  rmSync(packDir, { recursive: true, force: true })
  mkdirSync(packDir, { recursive: true })
  try {
    // npm reads project config from the nearest package.json, so this pins the .npmrc below.
    writeFileSync(
      join(packDir, 'package.json'),
      '{"name":"qvac-gpr-prebuild-pack","version":"0.0.0","private":true}'
    )
    if (gpr) {
      if (!token)
        throw new Error(
          `${spec} is on GitHub Packages but no token was given; the job needs packages: read`
        )
      if (!name.endsWith('-mono'))
        console.log(`::warning::${name} has no -mono suffix; dev builds publish as ${name}-mono`)
      const npmrc = join(packDir, '.npmrc')
      writeFileSync(npmrc, '')
      chmodSync(npmrc, 0o600)
      writeFileSync(
        npmrc,
        `@tetherto:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${token}\n`
      )
      const registry = String(
        run('npm', ['config', 'get', '@tetherto:registry'], {
          cwd: packDir,
          encoding: 'utf8',
          stdio: 'pipe'
        })
      ).trim()
      if (!isGprRegistry(registry))
        throw new Error(`@tetherto resolves to '${registry}'; the .npmrc in ${packDir} is shadowed`)
    }
    const meta = packOne(spec, join(packDir, 'meta'), { packDir, run })
    if (meta.name !== name) throw new Error(`resolved to ${meta.name} but the spec named ${name}`)
    if (addonOf(meta.name) !== addonOf(addon))
      throw new Error(`${meta.name} is not a build of ${addon}`)
    const want = pkg.slice(pkg.lastIndexOf('@') + 1)
    if (pinned && pkg && isExact(want) && meta.version !== want)
      throw new Error(`resolved to ${meta.name}@${meta.version} but the pin is ${want}`)
    let from = join(packDir, 'meta/package/prebuilds')
    if (!existsSync(from)) {
      if (gpr)
        throw new Error(
          `${meta.name}@${meta.version} ships no prebuilds/; GPR dev builds are never sliced`
        )
      const slice = sliceFor(meta, platform)
      const got = packOne(slice, join(packDir, 'platform'), { packDir, run })
      if (`${got.name}@${got.version}` !== slice)
        throw new Error(`${slice} resolved to ${got.name}@${got.version}`)
      from = join(packDir, 'platform/package/prebuilds')
      if (!existsSync(from) || !readdirSync(from).length)
        throw new Error(`${slice} contains no prebuilds`)
    }
    renameSync(from, out)
    console.log(
      `Prebuilds from ${meta.name}@${meta.version} (${gpr ? 'GitHub Packages' : 'npmjs'})`
    )
  } finally {
    rmSync(packDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  packPrebuilds({
    workdir: env.WORKDIR,
    pkg: env.PACKAGE || '',
    addon: env.ADDON,
    platform: env.PLATFORM,
    pinned: env.PINNED === 'true',
    token: env.GPR_TOKEN,
    tmp: env.RUNNER_TEMP,
    run: (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
  })
}
