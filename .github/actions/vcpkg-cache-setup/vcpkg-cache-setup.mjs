#!/usr/bin/env node
// s3 for prebuilds; files for C++ tests: a host dir that outlives the job, plus the workspace.

import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SAFE = /^[A-Za-z0-9/_.-]+$/

export function s3Sources({ bucket, platform, arch }) {
  if (!bucket) throw new Error('cache-bucket is required for s3 mode')
  for (const v of [platform, arch])
    if (!SAFE.test(v || '')) throw new Error(`invalid platform/arch: ${v}`)
  return `clear;x-aws,s3://${bucket}/vcpkg-cache/${platform}-${arch}/,readwrite`
}

export function hostCandidates(env) {
  if (env.VCPKG_HOST_CACHE_DIR) return [env.VCPKG_HOST_CACHE_DIR]
  if (env.RUNNER_OS === 'Windows')
    return ['C:\\qvac\\vcpkg-cache', join(env.LOCALAPPDATA || homedir(), 'qvac', 'vcpkg-cache')]
  const shared =
    env.RUNNER_OS === 'macOS' ? '/Users/Shared/qvac-vcpkg-cache' : '/var/tmp/qvac-vcpkg-cache'
  return ['/opt/qvac/vcpkg-cache', shared, join(homedir(), '.cache', 'qvac', 'vcpkg-cache')]
}

export function filesSources({ hostDir, cacheDir, trusted }) {
  const host = hostDir ? `;files,${hostDir},${trusted ? 'write' : 'read'}` : ''
  return `clear${host};files,${cacheDir},readwrite`
}

// The groups check the PR out under src/; the path reaches GITHUB_ENV, so nothing else is allowed.
export function cacheDirFor(workspace, workdir) {
  if (!/^(src\/)?packages\/[A-Za-z0-9._-]+$/.test(workdir || ''))
    throw new Error(`unexpected workdir: ${workdir}`)
  return resolve(workspace, workdir, 'vcpkg', 'cache')
}

function writable(dir) {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      try {
        chmodSync(dir, 0o1777)
      } catch {}
    }
    const probe = join(dir, `.write-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe)
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function main(env) {
  let lines
  if (env.MODE === 's3') {
    lines = [
      `VCPKG_BINARY_SOURCES=${s3Sources({ bucket: env.CACHE_BUCKET, platform: env.PLATFORM, arch: env.ARCH })}`
    ]
  } else {
    const cacheDir = cacheDirFor(env.GITHUB_WORKSPACE, env.WORKDIR)
    mkdirSync(cacheDir, { recursive: true })
    const selfHosted = env.RUNNER_ENVIRONMENT !== 'github-hosted'
    const hostDir = selfHosted ? hostCandidates(env).find(writable) || '' : ''
    if (selfHosted && !hostDir)
      console.log('::warning::no writable host cache dir; workspace layer only')
    lines = [
      `VCPKG_BINARY_SOURCES=${filesSources({ hostDir, cacheDir, trusted: env.TRUSTED === 'true' })}`,
      `VCPKG_CACHE_DIR=${cacheDir}`,
      `VCPKG_CACHE_PERSISTENT=${Boolean(hostDir)}`
    ]
  }
  console.log(lines.join('\n'))
  appendFileSync(env.GITHUB_ENV, lines.map((l) => `${l}\n`).join(''))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
