#!/usr/bin/env node
// Drops static libraries, strips debug info, then fails if any binary still carries it.

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHIPPED = /\.(bare|so|dylib)$/

export function binaries(dir, extraNames = []) {
  for (const n of extraNames)
    if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`Invalid executable basename: ${n}`)
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && (SHIPPED.test(e.name) || extraNames.includes(basename(p)))) out.push(p)
    }
  }
  walk(dir)
  return out
}

export function staticLibs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.a'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

export function tools(platform, toolchain) {
  if (platform === 'darwin' || platform === 'ios')
    return {
      strip: ['strip', '-S'],
      debug: (f) => ['file', [f], /with debug_info/]
    }
  if (platform === 'linux')
    return {
      strip: ['strip', '--strip-debug'],
      debug: (f) => ['file', [f], /with debug_info/]
    }
  if (platform === 'android') {
    return {
      strip: [join(toolchain, 'bin/llvm-strip'), '--strip-debug'],
      debug: (f) => [join(toolchain, 'bin/llvm-readelf'), ['-S', f], /\.debug_|\.zdebug_/]
    }
  }
  return null
}

function main(env) {
  const prebuilds = join(env.WORKDIR, 'prebuilds')
  for (const lib of staticLibs(prebuilds)) {
    console.log(`Removing ${lib}`)
    rmSync(lib)
  }
  const t = tools(
    env.PLATFORM,
    env.ANDROID_TOOLCHAIN_ROOT ||
      join(env.ANDROID_NDK_HOME || '', 'toolchains/llvm/prebuilt/linux-x86_64')
  )
  if (!t) return console.log(`No strip step for ${env.PLATFORM}`)
  const files = binaries(prebuilds, (env.EXTRA_NAMES || '').split('\n').filter(Boolean))
  for (const f of files) execFileSync(t.strip[0], [...t.strip.slice(1), f], { stdio: 'inherit' })
  const withDebug = files.filter((f) => {
    const [cmd, args, re] = t.debug(f)
    try {
      return re.test(execFileSync(cmd, args, { encoding: 'utf8' }))
    } catch {
      return false
    }
  })
  if (withDebug.length) {
    console.log(`::error::These binaries still contain debug info:\n${withDebug.join('\n')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
