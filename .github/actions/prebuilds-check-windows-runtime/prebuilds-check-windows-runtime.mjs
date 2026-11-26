#!/usr/bin/env node
// Addons link the static MSVC runtime, so no shipped binary may import the dynamic one.

import { existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FORBIDDEN = [
  /vcruntime\d/i,
  /msvcp\d/i,
  /msvcr\d/i,
  /msvcrt\.dll/i,
  /ucrtbase/i,
  /api-ms-win-crt/i,
  /concrt\d/i
]

export function violations(binary, dependents) {
  return dependents
    .split('\n')
    .filter((l) => FORBIDDEN.some((re) => re.test(l)))
    .map((l) => `${binary} -> ${l.trim()}`)
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
  const found = binaries.flatMap((b) =>
    violations(
      b,
      execFileSync(dumpbin, ['/nologo', '/dependents', b], {
        encoding: 'utf8'
      })
    )
  )
  if (found.length) {
    console.log(
      `::error::Dynamic C/C++ runtime dependency in Windows prebuilds:\n${found.join('\n')}`
    )
    process.exit(1)
  }
  console.log(`OK: ${binaries.length} binaries import no dynamic C/C++ runtime`)
}
