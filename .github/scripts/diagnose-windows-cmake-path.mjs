#!/usr/bin/env node
/**
 * Report every cmake on PATH of a Windows host, where each PATH entry is
 * configured (machine, user, or the current process), which npm package owns
 * a .cmd shim, and which cmake vcpkg would pick with an empty downloads
 * directory.
 *
 * vcpkg runs the selected cmake in a clean environment without node on PATH.
 * An npm .cmd shim passes vcpkg's version check but then fails there with
 * '"node"' is not recognized.
 *
 * Usage: node .github/scripts/diagnose-windows-cmake-path.mjs [--vcpkg]
 *   --vcpkg  also run `vcpkg fetch cmake` from VCPKG_ROOT with a temporary
 *            downloads directory (may download vcpkg's cmake).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAMES = ['cmake.exe', 'cmake.cmd', 'cmake.bat', 'cmake.ps1', 'cmake']

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function expand(value) {
  return value.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
}

function normalize(dir) {
  return path.resolve(expand(dir.trim().replace(/^"|"$/g, ''))).replace(/[\\/]+$/, '').toLowerCase()
}

function registryPath(key) {
  const { out } = run('reg', ['query', key, '/v', 'Path'])
  const match = out.match(/\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im)
  return match ? match[1].split(';').filter(Boolean) : []
}

function ownerPackage(file) {
  let dir = path.dirname(file)
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (name) return `${name}@${version} (${dir})`
      } catch {}
    }
    dir = path.dirname(dir)
  }
  return 'unknown'
}

function describeShim(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = []
  const target = text.match(/"%dp0%\\([^"]+)"\s+%\*/)
  if (target) {
    const resolved = path.resolve(path.dirname(file), target[1])
    lines.push(`npm shim -> ${resolved}`)
    lines.push(`owning package: ${ownerPackage(resolved)}`)
    const nodeNext = fs.existsSync(path.join(path.dirname(file), 'node.exe'))
    lines.push(nodeNext
      ? 'node.exe sits next to the shim (works without node on PATH)'
      : 'no node.exe next to the shim (falls back to "node" on PATH; breaks in vcpkg)')
  } else {
    lines.push('first lines:')
    lines.push(...text.split(/\r?\n/).slice(0, 5).map((l) => `  ${l}`))
  }
  return lines
}

function version(file) {
  const args = ['--version']
  const r = /\.(cmd|bat)$/i.test(file)
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${file}" --version`], { windowsVerbatimArguments: true })
    : /\.ps1$/i.test(file)
      ? run('powershell', ['-NoProfile', '-File', file, ...args])
      : run(file, args)
  return r.out.split(/\r?\n/)[0] || `(exit ${r.status}, no output)`
}

function main() {
  if (process.platform !== 'win32') {
    console.log('Not a Windows host; nothing to check.')
    return
  }

  const machine = new Set(registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').map(normalize))
  const user = new Set(registryPath('HKCU\\Environment').map(normalize))

  console.log(`host=${os.hostname()} user=${os.userInfo().username} node=${process.execPath}`)
  console.log(`npm global prefix: ${run('npm', ['prefix', '-g'], { shell: true }).out}`)
  console.log('npm global packages:')
  console.log(run('npm', ['ls', '-g', '--depth=0'], { shell: true }).out)
  console.log('')

  const seen = new Set()
  let found = 0
  const entries = (process.env.PATH || '').split(';').filter(Boolean)
  entries.forEach((entry, index) => {
    const key = normalize(entry)
    if (seen.has(key)) return
    seen.add(key)
    for (const name of NAMES) {
      const file = path.join(expand(entry), name)
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
      found++
      const origin = [machine.has(key) && 'machine PATH', user.has(key) && 'user PATH'].filter(Boolean).join(' + ') ||
        'process only (set by the job, a step, or a parent process)'
      console.log(`[PATH #${index}] ${file}`)
      console.log(`  PATH entry from: ${origin}`)
      console.log(`  --version: ${version(file)}`)
      if (/\.(cmd|bat)$/i.test(name)) {
        for (const line of describeShim(file)) console.log(`  ${line}`)
      }
    }
  })
  if (!found) console.log('No cmake found on PATH.')

  if (process.argv.includes('--vcpkg')) {
    const root = process.env.VCPKG_ROOT
    const exe = root && path.join(root, 'vcpkg.exe')
    console.log('')
    if (!exe || !fs.existsSync(exe)) {
      console.log(`vcpkg.exe not found (VCPKG_ROOT=${root ?? 'unset'})`)
      return
    }
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpkg-dl-'))
    const env = { ...process.env, VCPKG_DOWNLOADS: downloads }
    delete env.VCPKG_FORCE_DOWNLOADED_BINARIES
    delete env.VCPKG_FORCE_SYSTEM_BINARIES
    const r = run(exe, ['fetch', 'cmake'], { env })
    const picked = r.out.split(/\r?\n/).pop()
    console.log(`vcpkg (${exe}) picks cmake with empty downloads: ${picked}`)
    fs.rmSync(downloads, { recursive: true, force: true })
  }
}

main()
