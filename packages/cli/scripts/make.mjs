// Adapted from tetherto/qvac-core#291, head 30fe9473.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const stow = require('bare-stow')
const sidecarTarget = require('./sidecar-target.cjs')
const Bundle = require('bare-bundle')
const {
  deferSpecifiers,
  deferredAddonPackages,
  copyAddonExternals
} = require('@qvac/harness/addon-externals')
const addonSeeds = new Set()

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { env } = process
const host = env.HOST || `${process.platform}-${process.arch}`
const bin = host.startsWith('win32') ? 'qvac.exe' : 'qvac'
const launcher = path.join(root, 'dist')
const runtime = path.join(launcher, 'runtime')
const out = path.join(root, 'out', 'make')

const CHILDREN = {
  sidecar: 'node_modules/@qvac/core/worker/assistant-sidecar.mjs',
  harness: 'dist/standalone/harness.js'
}

async function make() {
  fs.rmSync(runtime, { recursive: true, force: true })
  fs.mkdirSync(runtime, { recursive: true })

  for (const [name, entry] of Object.entries(CHILDREN)) {
    await stowChild(name, entry)
  }

  copyAddonExternals(
    path.join(root, 'node_modules'),
    path.join(runtime, 'node_modules'),
    [host],
    [...addonSeeds]
  )
  stageSkills()
  stageRelease()
  console.log(`[make] stowed ${Object.keys(CHILDREN).length} children for ${host}`)

  if (process.argv.includes('--stage')) {
    return
  }

  await build()
  if (env.KEYCHAIN_PROFILE) {
    await notarize()
  }
}

async function stowChild(name, entry) {
  const artifacts = stow(
    pathToFileURL(path.join(root, entry)).href,
    sidecarTarget,
    pathToFileURL(path.join(runtime, `${name}.cjs`)).href,
    {
      base: pathToFileURL(root + path.sep).href,
      hosts: [host],
      // QuickJS imports Node's module helper only when process.versions.node exists.
      defer: [...deferSpecifiers(), 'module']
    }
  )

  for await (const artifact of artifacts) {
    void artifact
  }

  const bundle = Bundle.from(fs.readFileSync(path.join(runtime, `${name}.bundle`)))
  for (const pkg of deferredAddonPackages(bundle)) {
    addonSeeds.add(pkg)
  }
}

// Read by path at runtime, so neither bundling nor stow's offload covers them.
function stageSkills() {
  fs.cpSync(path.join(root, 'skills'), path.join(runtime, 'cli-skills'), {
    recursive: true,
    dereference: true
  })
  fs.cpSync(
    path.join(root, 'node_modules', '@qvac', 'skills', 'skills'),
    path.join(runtime, 'skills'),
    {
      recursive: true,
      dereference: true
    }
  )
}

function stageRelease() {
  const manifests = {
    '@qvac/cli': path.join(root, 'package.json'),
    '@qvac/core': path.join(root, 'node_modules', '@qvac', 'core', 'package.json'),
    '@qvac/harness': path.join(root, 'node_modules', '@qvac', 'harness', 'package.json'),
    '@qvac/sdk': path.join(root, 'node_modules', '@qvac', 'sdk', 'package.json')
  }
  const versions = Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [
      name,
      JSON.parse(fs.readFileSync(manifest, 'utf8')).version
    ])
  )

  const core = JSON.parse(fs.readFileSync(manifests['@qvac/cli'], 'utf8'))
  const release = {
    version: core.version,
    upgrade: env.UPGRADE_KEY || core.upgrade,
    versions
  }

  fs.writeFileSync(path.join(runtime, 'release.json'), JSON.stringify(release, null, 2) + '\n')
}

async function build() {
  const flags = []
  if (env.MAC_CODESIGN_IDENTITY || env.KEYCHAIN_PROFILE) {
    flags.push('--sign')
    if (env.MAC_CODESIGN_IDENTITY) {
      flags.push('--hardened-runtime', '--identity', env.MAC_CODESIGN_IDENTITY)
      flags.push('--entitlements', path.join(root, 'scripts', 'entitlements.plist'))
    }

    if (env.KEYCHAIN_PROFILE) {
      flags.push('--keychain', env.KEYCHAIN_PROFILE)
    }
  }

  console.log(`[make] bare-build ${host}${flags.length ? ' (signed)' : ''}`)
  await run('bare-build', [
    '--standalone',
    '--base',
    root,
    '--name',
    'qvac',
    '--description',
    'the qvac assistant in your terminal',
    '--host',
    host,
    '--out',
    out,
    ...flags,
    path.join(launcher, 'standalone.js')
  ])
}

async function notarize() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-notarize-'))
  try {
    const zip = path.join(tmp, 'qvac.zip')
    await run('ditto', ['-c', '-k', '--sequesterRsrc', findBinary(), zip])
    await run('xcrun', [
      'notarytool',
      'submit',
      zip,
      '--keychain-profile',
      env.KEYCHAIN_PROFILE,
      '--wait'
    ])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function findBinary() {
  for (const entry of fs.readdirSync(out, {
    recursive: true,
    withFileTypes: true
  })) {
    if (entry.isFile() && entry.name === bin) {
      return path.join(entry.parentPath, entry.name)
    }
  }

  throw new Error(`[make] no ${bin} under ${out}`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: host.startsWith('win32')
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}`))
      }
    })
  })
}

make().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
