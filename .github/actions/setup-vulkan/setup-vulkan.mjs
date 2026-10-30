#!/usr/bin/env node
// Linux arm64 has no prebuilt SDK, so it is built from source or restored from S3.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveVersion(input, configText) {
  const v = (input || configText || 'latest').replace(/\s/g, '')
  if (v !== 'latest' && !/^\d+\.\d+\.\d+\.\d+$/.test(v))
    throw new Error(`Vulkan SDK version must be latest or x.y.z.n, got ${v}`)
  return v
}

export function downloadUrl(os, version) {
  if (os === 'windows') {
    return version === 'latest'
      ? 'https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-sdk.exe'
      : `https://sdk.lunarg.com/sdk/download/${version}/windows/vulkansdk-windows-X64-${version}.exe`
  }
  return version === 'latest'
    ? 'https://sdk.lunarg.com/sdk/download/latest/linux/vulkan_sdk.tar.xz'
    : `https://sdk.lunarg.com/sdk/download/${version}/linux/vulkansdk-linux-x86_64-${version}.tar.xz`
}

export function envFor(os, sdk, env = {}) {
  if (os === 'windows') return { lines: [`VULKAN_SDK=${sdk}`], path: `${sdk}\\Bin` }
  const join2 = (dir, prev) => (prev ? `${dir}:${prev}` : dir)
  return {
    lines: [
      `VULKAN_SDK=${sdk}`,
      `LD_LIBRARY_PATH=${join2(`${sdk}/lib`, env.LD_LIBRARY_PATH)}`,
      `VK_ADD_LAYER_PATH=${sdk}/share/vulkan/explicit_layer.d`,
      `PKG_CONFIG_PATH=${join2(`${sdk}/share/pkgconfig:${sdk}/lib/pkgconfig`, env.PKG_CONFIG_PATH)}`
    ],
    path: `${sdk}/bin`
  }
}

// Preinstalled runner SDKs only ever got VULKAN_SDK, plus PATH on Windows.
export function preinstalledEnv(os, sdk) {
  return { lines: [`VULKAN_SDK=${sdk}`], path: os === 'windows' ? `${sdk}\\Bin` : '' }
}

export function sdkVersionFromReadme(text) {
  return (text.match(/sdk\/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || ''
}

async function download(url, out) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((e) => ({ ok: false, statusText: e.message }))
    if (res.ok) return writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    if (attempt === 5)
      throw new Error(`download failed: ${url} ${res.status ?? ''} ${res.statusText}`)
    await new Promise((r) => setTimeout(r, 10_000 * attempt))
  }
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })

async function install(env, version) {
  const os = env.RUNNER_OS === 'Windows' ? 'windows' : 'linux'
  const out = join(env.RUNNER_TEMP, os === 'windows' ? 'vulkan-sdk.exe' : 'vulkansdk.tar.xz')
  await download(downloadUrl(os, version), out)
  if (os === 'windows') {
    run(out, [
      '--root',
      'C:\\VulkanSDK',
      '--accept-licenses',
      '--default-answer',
      '--confirm-command',
      'install'
    ])
    return { sdk: 'C:\\VulkanSDK' }
  }
  const home = join(env.HOME, 'vulkan')
  mkdirSync(home, { recursive: true })
  run('sudo', ['apt', 'install', '-y', 'xz-utils'])
  run('tar', ['xf', out, '--directory', home, '--strip-components=1'])
  if (env.ARCH !== 'arm64') return { sdk: join(home, 'x86_64') }
  const key = `vulkan-sdk-cache/linux-arm64-${version === 'latest' ? sdkVersionFromReadme(readFileSync(join(home, 'README.txt'), 'utf8')) : version}.tar.gz`
  const archive = join(env.RUNNER_TEMP, 'vulkan-arm64-cache.tar.gz')
  try {
    run('aws', ['s3', 'cp', `s3://${env.CACHE_BUCKET}/${key}`, archive])
    run('tar', ['xzf', archive, '-C', home])
    return { sdk: join(home, 'aarch64'), cacheHit: true, key }
  } catch {
    run('./vulkansdk', ['--maxjobs'], { cwd: home })
    run('tar', ['czf', archive, 'aarch64'], { cwd: home })
    return { sdk: join(home, 'aarch64'), cacheHit: false, key, archive }
  }
}

// Where the self-hosted images ship an SDK; a hosted runner has neither and installs one.
export const IMAGE_ROOTS = { 'linux-x64': '/opt/vulkansdk/x86_64', 'windows-x64': 'C:\\VulkanSDK' }

export function preinstalledRoot(env, exists) {
  if (env.SDK_ROOT) return exists(env.SDK_ROOT) ? env.SDK_ROOT : ''
  const root = IMAGE_ROOTS[`${env.RUNNER_OS === 'Windows' ? 'windows' : 'linux'}-${env.ARCH}`]
  return root && exists(root) ? root : ''
}

async function main(env) {
  if (env.RUNNER_OS === 'macOS') return console.log('No Vulkan SDK step on macOS')
  const config = '.github/config/vulkan-sdk-version.txt'
  const version = resolveVersion(
    env.INPUT_VERSION,
    existsSync(config) ? readFileSync(config, 'utf8') : ''
  )
  const os = env.RUNNER_OS === 'Windows' ? 'windows' : 'linux'
  const root = preinstalledRoot(env, existsSync)
  const preinstalled = Boolean(root)
  const r = preinstalled ? { sdk: root } : await install(env, version)
  const { lines, path } = preinstalled ? preinstalledEnv(os, r.sdk) : envFor(os, r.sdk, env)
  appendFileSync(env.GITHUB_ENV, lines.map((l) => `${l}\n`).join(''))
  if (path) appendFileSync(env.GITHUB_PATH, `${path}\n`)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `upload-archive=${r.cacheHit === false ? r.archive : ''}\nupload-key=${r.key ?? ''}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)
