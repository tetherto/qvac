#!/usr/bin/env node
// Release MSVC runtimes must ship with the package or a declared native dependency.
// Modern Windows provides UCRT; Debug and legacy redistributables are not supported.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REDISTRIBUTABLE = /^(?:vcruntime|msvcp|concrt)\d[\w]*\.dll$/i
// VS 2015 and later use the VC14 runtime family, including suffixed Release DLLs.
const SUPPORTED_REDISTRIBUTABLE = /^(?:vcruntime|msvcp|concrt)140(?:_\w+)?\.dll$/i
const FORBIDDEN = [
  /^(?:vcruntime|msvcp|concrt)\d[\w]*d\.dll$/i,
  /^ucrtbased\.dll$/i,
  /^msvcr\d.*\.dll$/i
]

export function violations(binary, dependents, available = new Set()) {
  const imports = dependents.split(/\r?\n/).map((line) => line.trim())
  return imports.flatMap((name) => {
    if (
      FORBIDDEN.some((pattern) => pattern.test(name)) ||
      (REDISTRIBUTABLE.test(name) && !SUPPORTED_REDISTRIBUTABLE.test(name))
    )
      return [`${binary} -> unsupported Debug/legacy runtime ${name}`]
    if (REDISTRIBUTABLE.test(name) && !available.has(name.toLowerCase()))
      return [`${binary} -> missing packaged runtime ${name}`]
    return []
  })
}

// Follow declared dependencies, including workspace links restored by provider CI.
// Do not let unrelated package artifacts satisfy a missing runtime.
function runtimeDirectories(packageRoot, host, seen = new Set()) {
  packageRoot = resolve(packageRoot)
  if (seen.has(packageRoot)) return []
  seen.add(packageRoot)
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const directories = [join(packageRoot, 'prebuilds', host)]
  const require = createRequire(join(packageRoot, 'package.json'))
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies
  })) {
    let file
    for (const specifier of [`${name}/package`, `${name}/package.json`]) {
      try {
        file = require.resolve(specifier)
        break
      } catch {}
    }
    if (file) directories.push(...runtimeDirectories(dirname(file), host, seen))
  }
  return directories
}

const tryRun = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Windows tools print CRLF lines, and vswhere lists the cross-compilers too: take the x64-hosted x64 tool.
export function pickDumpbin(output) {
  const paths = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return paths.find((p) => /Hostx64[\\/]x64[\\/]dumpbin\.exe$/i.test(p)) ?? ''
}

// PATH, then vswhere, then the install roots; the self-hosted fleet has Build Tools vswhere cannot see.
function findDumpbin(env) {
  const onPath = tryRun('where', ['dumpbin']).split(/\r?\n/)[0].trim()
  if (onPath) return onPath
  const vswhere = join(
    env['ProgramFiles(x86)'] ?? '',
    'Microsoft Visual Studio/Installer/vswhere.exe'
  )
  const viaVswhere = existsSync(vswhere)
    ? pickDumpbin(
        tryRun(vswhere, ['-latest', '-prerelease', '-products', '*', '-find', '**\\dumpbin.exe'])
      )
    : ''
  if (viaVswhere) return viaVswhere
  for (const root of [
    join(env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio'),
    join(env.ProgramFiles ?? '', 'Microsoft Visual Studio')
  ]) {
    if (!existsSync(root)) continue
    const hit = readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => /Hostx64[\\/]x64[\\/]dumpbin\.exe$/i.test(f))
      .sort()
      .reverse()[0]
    if (hit) return join(root, hit)
  }
  throw new Error(
    'dumpbin.exe not found on PATH, through vswhere, or under the Visual Studio roots'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join(process.env.WORKDIR, 'prebuilds')
  if (!existsSync(dir)) throw new Error(`${dir} does not exist; nothing to check`)
  const binaries = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(bare|dll|exe)$/i.test(f))
    .map((f) => join(dir, f))
  if (!binaries.length) throw new Error(`no .bare, .dll or .exe under ${dir}`)
  const dumpbin = findDumpbin(process.env)
  const runtimes = new Map()
  const found = binaries.flatMap((b) => {
    const host = relative(dir, b).split(/[\\/]/)[0]
    if (!runtimes.has(host)) {
      const directories = runtimeDirectories(process.env.WORKDIR, host)
      runtimes.set(
        host,
        new Set(
          directories.flatMap((directory) =>
            existsSync(directory) ? readdirSync(directory).map((name) => name.toLowerCase()) : []
          )
        )
      )
    }
    const available = runtimes.get(host)
    return violations(
      b,
      execFileSync(dumpbin, ['/nologo', '/dependents', b], { encoding: 'utf8' }),
      available
    )
  })
  if (found.length) {
    console.log(
      `::error::Unsupported or unpackaged C/C++ runtime in Windows prebuilds:\n${found.join('\n')}`
    )
    process.exit(1)
  }
  console.log(`OK: ${binaries.length} binaries use supported, packaged C/C++ runtimes`)
}
