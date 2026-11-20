const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const http = require('node:http')
const { fixture } = require('./packaging-fixture')

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test(
  'npm installs CUDA automatically while retaining HIP in the base package and deduplicates the runtime cycle',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' },
  async (t) => {
    const f = await fixture(t)
    f.slicePlatformPackages(f)
    const packages = new Map()
    const server = http.createServer((req, res) => {
      const request = decodeURIComponent(req.url)
      if (request.startsWith('/tarballs/')) {
        const pkg = [...packages.values()].find((pkg) => request === '/tarballs/' + pkg.filename)
        if (pkg) return res.end(pkg.tarball)
      } else if (packages.has(request.slice(1))) {
        const pkg = packages.get(request.slice(1))
        res.setHeader('content-type', 'application/json')
        return res.end(
          JSON.stringify({
            name: pkg.manifest.name,
            'dist-tags': { latest: pkg.manifest.version },
            versions: {
              [pkg.manifest.version]: {
                ...pkg.manifest,
                dist: {
                  shasum: pkg.shasum,
                  integrity: pkg.integrity,
                  tarball: 'http://127.0.0.1:' + server.address().port + '/tarballs/' + pkg.filename
                }
              }
            }
          })
        )
      }
      res.writeHead(404)
      res.end('not found')
    })
    t.after(() => server.close())
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    for (const suffix of ['linux-x64', 'linux-x64-cuda']) {
      const dir = path.join(f.outDir, 'qvac-fabric-' + suffix)
      const result = spawnSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--cache', path.join(f.root, 'cache')],
        { cwd: dir, encoding: 'utf8' }
      )
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      const info = JSON.parse(result.stdout)[0]
      const manifest = json(path.join(dir, 'package.json'))
      packages.set(manifest.name, {
        ...info,
        manifest,
        tarball: fs.readFileSync(path.join(dir, info.filename))
      })
    }
    const app = path.join(f.root, 'app')
    fs.mkdirSync(app)
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        dependencies: { '@qvac/fabric-linux-x64': f.manifest.version }
      })
    )
    await promisify(execFile)(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        'http://127.0.0.1:' + server.address().port,
        '--cache',
        path.join(f.root, 'cache')
      ],
      { cwd: app }
    )
    assert.ok(!fs.existsSync(path.join(app, 'node_modules/@qvac/fabric-linux-x64-hip')))
    assert.ok(
      fs.existsSync(
        path.join(
          app,
          'node_modules/@qvac/fabric-linux-x64/prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-hip.so'
        )
      )
    )
    for (const suffix of ['linux-x64', 'linux-x64-cuda']) {
      const pkg = json(path.join(app, 'node_modules/@qvac/fabric-' + suffix, 'package.json'))
      assert.equal(pkg.version, f.manifest.version)
      assert.ok(
        !fs.existsSync(
          path.join(
            app,
            'node_modules/@qvac/fabric-' + suffix,
            'node_modules/@qvac/fabric-linux-x64'
          )
        )
      )
    }
  }
)

test('Linux x64 is split into version-locked base and CUDA packages', async (t) => {
  const f = await fixture(t)
  const slices = f.slicePlatformPackages(f)
  assert.equal(slices.length, 8)
  const base = path.join(f.outDir, 'qvac-fabric-linux-x64')
  const manifest = json(path.join(base, 'package.json'))
  assert.deepEqual(manifest.dependencies, {
    '@qvac/fabric-linux-x64-cuda': f.manifest.version
  })
  assert.equal(manifest.optionalDependencies, undefined)
  const host = path.join(base, 'prebuilds/linux-x64')
  assert.deepEqual(fs.readdirSync(host).sort(), [
    'qvac__fabric-linux-x64',
    'qvac__fabric-linux-x64.bare',
    'qvac__fabric-linux-x64.bare.exports'
  ])
  assert.ok(fs.existsSync(path.join(host, 'qvac__fabric-linux-x64/fused_layer.xclbin')))
  assert.ok(fs.existsSync(path.join(host, 'qvac__fabric-linux-x64/libqvac-ggml-hip.so')))
  assert.ok(!fs.existsSync(path.join(f.outDir, 'qvac-fabric-linux-x64-hip')))
  for (const backend of ['cuda']) {
    const dir = path.join(f.outDir, 'qvac-fabric-linux-x64-' + backend)
    const m = json(path.join(dir, 'package.json'))
    assert.deepEqual(m.dependencies, { '@qvac/fabric-linux-x64': f.manifest.version })
    assert.deepEqual([m.os, m.cpu, m.libc], [['linux'], ['x64'], ['glibc']])
    const pack = spawnSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(f.root, 'cache')],
      { cwd: dir, encoding: 'utf8' }
    )
    assert.ifError(pack.error)
    assert.equal(pack.status, 0, pack.stderr)
    const files = JSON.parse(pack.stdout)[0].files.map((entry) => entry.path)
    const moduleName = 'qvac__fabric-linux-x64-' + backend
    for (const file of [
      'LICENSE',
      'NOTICE',
      'index.js',
      'prebuilds/linux-x64/' + moduleName + '.bare',
      'prebuilds/linux-x64/' + moduleName + '/libqvac-ggml-' + backend + '.so'
    ]) {
      assert.ok(files.includes(file), file)
    }
  }
  const meta = json(path.join(f.workdir, 'package.json'))
  assert.equal(meta.optionalDependencies['@qvac/fabric-linux-x64'], f.manifest.version)
  assert.equal(meta.optionalDependencies['@qvac/fabric-linux-x64-cuda'], undefined)
})

test('the platform entry loads the runtime and the CUDA carrier before returning its unchanged exports', async (t) => {
  const f = await fixture(t)
  f.slicePlatformPackages(f)
  const calls = []
  const exports = { backendsDir() {}, loadBackends() {} }
  const require = (name) => calls.push(name)
  require.addon = () => {
    calls.push('runtime')
    return exports
  }
  const module = {}
  vm.runInNewContext(
    fs.readFileSync(path.join(f.outDir, 'qvac-fabric-linux-x64/index.js'), 'utf8'),
    { require, module }
  )
  assert.deepEqual(calls, ['runtime', '@qvac/fabric-linux-x64-cuda'])
  assert.equal(module.exports, exports)
})

test('missing GPU payloads fail before moving any prebuilds', async (t) => {
  const f = await fixture(t)
  fs.unlinkSync(
    path.join(f.workdir, 'prebuilds/linux-x64/qvac__fabric-linux-x64-cuda/libqvac-ggml-cuda.so')
  )
  assert.throws(() => f.slicePlatformPackages(f), /Missing Fabric backend package file.*cuda/)
  assert.ok(fs.existsSync(path.join(f.workdir, 'prebuilds/linux-x64/qvac__fabric-linux-x64.bare')))
})

test('stale unsplit GPU modules cannot silently ship in the base package', async (t) => {
  const f = await fixture(t)
  fs.writeFileSync(
    path.join(f.workdir, 'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-cuda.so'),
    'stale'
  )
  assert.throws(() => f.slicePlatformPackages(f), /Stale unsplit Fabric backend/)
})

test('local source builds expose the CUDA carrier and keep rebuilds visible', async (t) => {
  const f = await fixture(t)
  const linked = f.linkLocalPlatformPackages(f)
  assert.equal(linked.length, 8)
  const name = 'qvac__fabric-linux-x64-cuda'
  const payload = name + '/libqvac-ggml-cuda.so'
  fs.writeFileSync(path.join(f.workdir, 'prebuilds/linux-x64', payload), 'rebuilt')
  assert.equal(
    fs.readFileSync(
      path.join(f.workdir, 'node_modules/@qvac/fabric-linux-x64-cuda/prebuilds/linux-x64', payload),
      'utf8'
    ),
    'rebuilt'
  )
  assert.deepEqual(json(path.join(f.workdir, 'package.json')), f.manifest)
})
