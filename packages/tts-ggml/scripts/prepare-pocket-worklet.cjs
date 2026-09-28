'use strict'
// Resolve pnpm's real package locations before traversing imports. Bare's
// pack/link tools otherwise search beside the logical node_modules symlink.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { fileURLToPath, pathToFileURL } = require('node:url')
const [source, output, modules] = process.argv.slice(2)
const tooling = createRequire(fs.realpathSync(path.join(modules, 'bare-pack', 'package.json')))
const pack = tooling('bare-pack')
const traverse = tooling('bare-module-traverse')
const packFs = tooling('./lib/fs')
const link = require(path.join(modules, 'bare-link'))
const hosts = ['ios-arm64-simulator']

const canonical = (url) =>
  url.protocol === 'file:' ? pathToFileURL(fs.realpathSync(fileURLToPath(url))) : url

async function main() {
  const bundle = await pack(
    pathToFileURL(path.join(source, 'test/mobile/pocket-worklet.cjs')),
    {
      hosts,
      linked: true,
      // This functional worklet does not enable brittle's Node-only coverage reporter.
      defer: ['bare-cov'],
      resolve: (entry, parent, options) => traverse.resolve.bare(entry, canonical(parent), options)
    },
    packFs.readModule,
    packFs.listPrefix
  )
  fs.writeFileSync(path.join(output, 'test.bundle'), bundle.toBuffer())

  const visited = new Set()
  async function visit(base) {
    base = fs.realpathSync(base)
    if (visited.has(base)) return
    visited.add(base)
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    const req = createRequire(path.join(base, 'package.json'))
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies
    }
    for (const name of Object.keys(dependencies)) {
      const found = (req.resolve.paths(name) || [])
        .map((dir) => path.join(dir, name))
        .find((dir) => fs.existsSync(path.join(dir, 'package.json')))
      if (found) await visit(found)
      else if (
        pkg.dependencies &&
        name in pkg.dependencies &&
        !(pkg.optionalDependencies && name in pkg.optionalDependencies)
      ) {
        throw new Error(`Missing dependency ${name} from ${base}`)
      }
    }
    if (pkg.addon !== true) return
    // Dependencies have already been visited at their canonical locations.
    const standalone = {
      ...pkg,
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
      bundleDependencies: []
    }
    for await (const item of link(
      base,
      { hosts, out: path.join(output, 'frameworks') },
      standalone
    )) {
      console.log(item)
    }
  }
  await visit(source)
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
