import fs from 'node:fs'
import path from 'node:path'

export const IOS_HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']

export interface FakePackageManager {
  binDir: string
  calls: () => { cwd: string; args: string[] }[]
}

export interface FakePackageManagerBehaviour {
  version?: string
  exitCode?: number
  installNothing?: boolean
  /**
   * The directory whose node_modules receives the packages, standing in for a
   * workspace root that npm, Yarn, and bun hoist into. Defaults to the
   * working directory.
   */
  installRoot?: string
}

/**
 * Writes an executable `name` into `<dir>/fake-bin` that answers `--version`
 * and, for an add, lays out each requested platform package the way the real
 * ones are built: an inner `addon/` package named after the meta addon,
 * holding a prebuild for every host the package covers. Put `binDir` first on
 * PATH with `withPath`.
 */
export function installFakePackageManager(
  dir: string,
  name: string,
  behaviour: FakePackageManagerBehaviour = {}
): FakePackageManager {
  const binDir = path.join(dir, 'fake-bin')
  const logPath = path.join(dir, `fake-${name}.log`)
  fs.mkdirSync(binDir, { recursive: true })
  const script = `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(behaviour.version ?? '9.0.0')} + '\\n')
  process.exit(0)
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n')
if (${behaviour.exitCode ?? 0} !== 0) {
  process.stderr.write('fake install failure')
  process.exit(${behaviour.exitCode ?? 0})
}
if (${behaviour.installNothing === true}) process.exit(0)
const iosHosts = ${JSON.stringify(IOS_HOSTS)}
for (const spec of args.filter((arg) => !arg.startsWith('-') && arg.includes('@', 1))) {
  const at = spec.lastIndexOf('@')
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  const ios = name.endsWith('-ios')
  const addon = ios ? name.slice(0, -'-ios'.length) : name.slice(0, -'-android-arm64'.length)
  const installRoot = ${JSON.stringify(behaviour.installRoot ?? null)} ?? process.cwd()
  const root = path.join(installRoot, 'node_modules', ...name.split('/'))
  fs.mkdirSync(path.join(root, 'addon'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' })
  )
  fs.writeFileSync(path.join(root, 'index.js'), "module.exports = require.addon('./addon')\\n")
  fs.writeFileSync(
    path.join(root, 'addon', 'package.json'),
    JSON.stringify({ name: addon, version, addon: true })
  )
  for (const host of ios ? iosHosts : ['android-arm64']) {
    const hostDir = path.join(root, 'addon', 'prebuilds', host)
    fs.mkdirSync(hostDir, { recursive: true })
    fs.writeFileSync(path.join(hostDir, 'addon.bare'), '')
  }
}
`
  const binPath = path.join(binDir, name)
  fs.writeFileSync(binPath, script)
  fs.chmodSync(binPath, 0o755)
  return {
    binDir,
    calls: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { cwd: string; args: string[] })
        : []
  }
}

export async function withPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env['PATH']
  process.env['PATH'] = `${binDir}${path.delimiter}${original ?? ''}`
  try {
    return await fn()
  } finally {
    process.env['PATH'] = original
  }
}
