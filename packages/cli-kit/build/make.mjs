// Adapted from tetherto/qvac-core#291, head 30fe9473.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const sidecarTarget = createRequire(import.meta.url)('./sidecar-target.cjs')
const kit = fileURLToPath(new URL('..', import.meta.url))
const { env } = process
const host = env.HOST || `${process.platform}-${process.arch}`

// The product's standalone binary: Core's sidecar and the kit's harness host stowed beside its
// launcher, with the addons, skills and release manifest they read from disk. The bundling tools
// and the packages they bundle resolve from the product's root, the tree the binary ships.
export async function make({
  name,
  binary,
  root,
  description,
  entry = 'dist/standalone.js',
  versions = [],
  stage = false
}) {
  const require = createRequire(path.join(root, 'package.json'))
  const stow = require('bare-stow')
  const Bundle = require('bare-bundle')
  const {
    deferSpecifiers,
    deferredAddonPackages,
    copyAddonExternals
  } = require('@qvac/harness/addon-externals')
  const addonSeeds = new Set()
  const launcher = path.join(root, 'dist')
  const runtime = path.join(launcher, 'runtime')
  const out = path.join(root, 'out', 'make')
  const bin = host.startsWith('win32') ? `${binary}.exe` : binary

  const children = {
    sidecar: path.join(root, 'node_modules/@qvac/core/worker/assistant-sidecar.mjs'),
    harness: path.join(kit, 'dist', 'standalone', 'harness.js')
  }

  fs.rmSync(runtime, { recursive: true, force: true })
  fs.mkdirSync(runtime, { recursive: true })

  for (const [child, file] of Object.entries(children)) {
    await stowChild(child, file)
  }

  copyAddonExternals(
    path.join(root, 'node_modules'),
    path.join(runtime, 'node_modules'),
    [host],
    [...addonSeeds]
  )
  stageSkills()
  stageRelease()
  console.log(`[make] stowed ${Object.keys(children).length} children for ${host}`)

  if (stage) {
    return
  }

  await build()
  if (env.KEYCHAIN_PROFILE) {
    await notarize()
  }

  async function stowChild(child, file) {
    const artifacts = stow(
      pathToFileURL(file).href,
      sidecarTarget,
      pathToFileURL(path.join(runtime, `${child}.cjs`)).href,
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

    const bundle = Bundle.from(fs.readFileSync(path.join(runtime, `${child}.bundle`)))
    for (const pkg of deferredAddonPackages(bundle)) {
      addonSeeds.add(pkg)
    }
  }

  // Read by path at runtime, so neither bundling nor stow's offload covers them.
  function stageSkills() {
    fs.cpSync(path.join(kit, 'skills'), path.join(runtime, 'cli-skills'), {
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

  // the product's version and upgrade key, with the versions of what it ships
  function stageRelease() {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const shipped = ['@qvac/core', '@qvac/harness', ...versions].map((pkg) => [
      pkg,
      JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8'))
        .version
    ])
    const release = {
      version: manifest.version,
      upgrade: env.UPGRADE_KEY || manifest.upgrade,
      versions: Object.fromEntries([[name, manifest.version], ...shipped])
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
      binary,
      '--description',
      description,
      '--host',
      host,
      '--out',
      out,
      ...flags,
      path.join(root, entry)
    ])
  }

  async function notarize() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${binary}-notarize-`))
    try {
      const zip = path.join(tmp, `${binary}.zip`)
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
