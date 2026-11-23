#!/usr/bin/env node
// Byte-compatible with vcpkg-toolchain-fingerprint, so existing cache keys still hit.

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Like bash $(cmd): stdout with trailing newlines removed.
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).replace(/\n+$/, '')

export function unixProbe({ os, clangVersion, sdkBuild, vcpkgVersion }) {
  const head = os === 'macOS' ? `${clangVersion}\nsdk=${sdkBuild}` : clangVersion
  return `${head}\nvcpkg=${vcpkgVersion}`
}

export const windowsProbe = ({ toolsVersion, sdkVersion, vcpkgVersion }) =>
  `vctools=${toolsVersion} sdk=${sdkVersion} vcpkg=${vcpkgVersion.trim()}`

export const fingerprint = (probe) =>
  createHash('sha256').update(probe, 'utf8').digest('hex').slice(0, 16)

function vcpkgVersion(env, exe) {
  const own = join(env.VCPKG_ROOT || '', exe)
  const bin = existsSync(own) ? own : exe
  const first = sh(bin, ['version']).split('\n')[0]
  if (!first.trim())
    throw new Error(`'${bin} version' printed nothing; cache key would be unstable`)
  return first
}

function probe(env) {
  if (env.RUNNER_OS !== 'Windows') {
    const mac = env.RUNNER_OS === 'macOS'
    return unixProbe({
      os: env.RUNNER_OS,
      clangVersion: mac
        ? sh('xcrun', ['clang', '--version'])
        : sh(env.CC || 'clang', ['--version']),
      sdkBuild: mac ? sh('xcrun', ['--show-sdk-build-version']) : '',
      vcpkgVersion: vcpkgVersion(env, 'vcpkg')
    })
  }
  const pf86 = env['ProgramFiles(x86)']
  const vs = sh(join(pf86, 'Microsoft Visual Studio/Installer/vswhere.exe'), [
    '-latest',
    '-products',
    '*',
    '-property',
    'installationPath'
  ]).trim()
  const toolsVersion = readFileSync(
    join(vs, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'),
    'utf8'
  ).trim()
  const sdks = readdirSync(join(pf86, 'Windows Kits/10/Include')).filter((d) =>
    /^\d+(\.\d+)+$/.test(d)
  )
  const sdkVersion = sdks.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  if (!toolsVersion || !sdkVersion) throw new Error('could not fingerprint the toolchain')
  return windowsProbe({
    toolsVersion,
    sdkVersion,
    vcpkgVersion: vcpkgVersion(env, 'vcpkg.exe')
  })
}

function main(env) {
  const p = probe(env)
  console.log(`--- toolchain ---\n${p}`)
  appendFileSync(env.GITHUB_ENV, `TOOLCHAIN_FINGERPRINT=${fingerprint(p)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
