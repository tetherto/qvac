import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  existsSync,
  utimesSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PACKAGES,
  validateRun,
  validateSources,
  applyOverrides,
  packPackage,
  downloadArtifact,
  extractArtifact,
  collectNativeCrashes,
  prepareSpeechPreflight,
  verifySpeechPreflight
} from '../../../packages/sdk/ci/speech-preflight.mjs'
import { buildSdk } from '../../../packages/sdk/ci/e2e.mjs'
import {
  expectedAddonFile,
  mangledAddonName
} from '../../../scripts/ci/slice-platform-packages.mjs'

const CONFIG = {
  repository: 'tetherto/qvac',
  sourceSha: 'a'.repeat(40),
  workflow: '.github/workflows/cache-warm.yml'
}
const RUN = {
  repository: { full_name: CONFIG.repository },
  head_sha: CONFIG.sourceSha,
  path: CONFIG.workflow,
  event: 'workflow_dispatch'
}
const BUNDLED = new Set(
  PACKAGES.filter((slug) => {
    const file = new URL(`../../../packages/${slug}/package.json`, import.meta.url)
    return JSON.parse(readFileSync(file)).addon === true
  })
)
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'speech-preflight-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('the SDK planner imports from its sparse checkout without packaging helpers', (t) => {
  const root = temporary(t)
  const source = fileURLToPath(new URL('../../../packages/sdk/ci/', import.meta.url))
  const destination = join(root, 'packages/sdk/ci')
  cpSync(source, destination, { recursive: true })
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await import(process.argv[1])',
      pathToFileURL(join(destination, 'e2e-report.mjs')).href
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('accepts the pinned native build and rejects a different revision, repository or workflow', () => {
  assert.doesNotThrow(() => validateRun(RUN, CONFIG))
  assert.throws(() => validateRun({ ...RUN, head_sha: 'b'.repeat(40) }, CONFIG), /provenance/)
  assert.throws(
    () => validateRun({ ...RUN, repository: { full_name: 'someone/qvac' } }, CONFIG),
    /provenance/
  )
  assert.throws(() => validateRun({ ...RUN, path: 'other.yml' }, CONFIG), /provenance/)
  assert.throws(() => validateRun({ ...RUN, event: 'pull_request' }, CONFIG), /provenance/)
})

test('without the opt-in manifest, the ordinary SDK installation remains unchanged', async (t) => {
  assert.equal(await prepareSpeechPreflight(temporary(t), {}), null)
})

test('rejects changed native sources, renamed source files and truncated comparisons', () => {
  assert.doesNotThrow(() =>
    validateSources({ status: 'ahead', files: [{ filename: 'packages/sdk/ci/e2e.mjs' }] })
  )
  assert.throws(
    () =>
      validateSources({ status: 'ahead', files: [{ filename: 'packages/asr-ggml/binding.js' }] }),
    /sources differ/
  )
  assert.throws(
    () =>
      validateSources({
        status: 'ahead',
        files: [{ filename: 'elsewhere.js', previous_filename: 'packages/asr-ggml/binding.js' }]
      }),
    /sources differ/
  )
  assert.throws(
    () =>
      validateSources({
        status: 'ahead',
        files: Array.from({ length: 300 }, () => ({ filename: 'docs/file.md' }))
      }),
    /sources differ/
  )
  assert.throws(() => validateSources({ status: 'behind', files: [] }), /sources differ/)
})

test('overrides also replace direct dependencies to avoid npm EOVERRIDE', (t) => {
  const file = join(temporary(t), 'package.json')
  writeJson(file, {
    dependencies: { '@qvac/asr-ggml': '^0.12.0', untouched: '^1.0.0' },
    overrides: { existing: '1.0.0' }
  })
  applyOverrides(file, [{ name: '@qvac/asr-ggml', spec: 'file:/tmp/asr.tgz' }])
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(manifest.dependencies['@qvac/asr-ggml'], 'file:/tmp/asr.tgz')
  assert.equal(manifest.overrides['@qvac/asr-ggml'], 'file:/tmp/asr.tgz')
  assert.equal(manifest.dependencies.untouched, '^1.0.0')
  assert.equal(manifest.overrides.existing, '1.0.0')
})

function installPackage(root, slug) {
  const directory = join(root, 'node_modules/@qvac', slug)
  mkdirSync(join(directory, 'prebuilds'), { recursive: true })
  writeJson(join(directory, 'package.json'), {
    name: `@qvac/${slug}`,
    exports: { './package': './package.json' }
  })
  writeFileSync(join(directory, 'prebuilds/runtime.bare'), slug)
  return {
    name: `@qvac/${slug}`,
    integrity: `sha512-${slug}`,
    native: [{ name: 'runtime.bare', hash: createHash('sha512').update(slug).digest('base64') }]
  }
}

function installation(t) {
  const root = temporary(t)
  mkdirSync(join(root, 'node_modules/@qvac/sdk'), { recursive: true })
  writeJson(join(root, 'node_modules/@qvac/sdk/package.json'), { name: '@qvac/sdk' })
  const packages = PACKAGES.map((slug) => installPackage(root, slug))
  writeJson(join(root, 'package-lock.json'), {
    packages: Object.fromEntries(
      packages.map((p) => [`node_modules/${p.name}`, { integrity: p.integrity }])
    )
  })
  return { root, provenance: { ...CONFIG, host: 'linux-x64', packages } }
}

test('checks installed tarballs and native payloads before writing provenance', (t) => {
  const { root, provenance } = installation(t)
  verifySpeechPreflight(root, provenance)
  assert.equal(
    JSON.parse(readFileSync(join(root, 'reports/speech-preflight-provenance.json'))).sourceSha,
    CONFIG.sourceSha
  )
  writeFileSync(join(root, 'node_modules/@qvac/asr-ggml/prebuilds/runtime.bare'), 'old binary')
  assert.throws(() => verifySpeechPreflight(root, provenance), /native payload differs/)
})

test('rejects published npm fallback and a separately resolved Fabric runtime', (t) => {
  const { root, provenance } = installation(t)
  const altered = structuredClone(provenance)
  altered.packages[0].integrity = 'sha512-published'
  assert.throws(() => verifySpeechPreflight(root, altered), /unexpected tarball/)
  installPackage(join(root, 'node_modules/@qvac/asr-ggml'), 'fabric')
  assert.throws(() => verifySpeechPreflight(root, provenance), /separate Fabric/)
})

function packageFixture(root, slug, host) {
  const workdir = join(root, 'packages', slug)
  mkdirSync(join(workdir, 'prebuilds', host), { recursive: true })
  const name = `@qvac/${slug}`
  const bundled = BUNDLED.has(slug)
  writeJson(join(workdir, 'package.json'), {
    name,
    version: '0.0.1',
    main: 'index.js',
    files: ['index.js', 'prebuilds'],
    exports: { '.': './index.js', './package': './package.json' },
    ...(bundled ? { addon: true } : { optionalDependencies: { [`${name}-${host}`]: '0.0.1' } }),
    ...(slug === 'fabric' ? {} : { dependencies: { '@qvac/fabric': '0.0.1' } })
  })
  writeFileSync(join(workdir, 'index.js'), 'module.exports = {}\n')
  const addon = bundled ? `${mangledAddonName(name)}.bare` : expectedAddonFile(name, host)
  writeFileSync(join(workdir, 'prebuilds', host, addon), slug)
  return workdir
}

function packFixtures(root, host) {
  return PACKAGES.flatMap((slug) =>
    packPackage(packageFixture(root, slug, host), root, host, {
      ...process.env,
      npm_config_cache: join(root, 'npm-cache')
    })
  )
}

function installFixture(root, packages) {
  const sdk = join(root, 'sdk')
  const e2e = join(root, 'consumer')
  mkdirSync(sdk, { recursive: true })
  mkdirSync(e2e, { recursive: true })
  writeJson(join(sdk, 'package.json'), {
    name: '@qvac/sdk',
    version: '0.0.1',
    dependencies: Object.fromEntries(PACKAGES.map((slug) => [`@qvac/${slug}`, '0.0.1']))
  })
  writeJson(join(e2e, 'package.json'), {
    name: 'preflight-fixture',
    version: '0.0.1',
    dependencies: { '@qvac/sdk': pathToFileURL(sdk).href }
  })
  applyOverrides(join(sdk, 'package.json'), packages)
  applyOverrides(join(e2e, 'package.json'), packages)
  const result = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--install-links', '--offline', '--no-audit', '--no-fund'],
    {
      cwd: e2e,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_cache: join(root, 'npm-cache') }
    }
  )
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
  return e2e
}

test('packs and installs only the current host, then verifies the actual npm installation', (t) => {
  const root = temporary(t)
  const host = `${process.platform}-${process.arch}`
  const packages = packFixtures(root, host)
  assert.equal(packages.length, PACKAGES.length * 2 - BUNDLED.size)
  assert.deepEqual(
    new Set(packages.map((p) => p.name)),
    new Set(
      PACKAGES.flatMap((slug) =>
        BUNDLED.has(slug) ? [`@qvac/${slug}`] : [`@qvac/${slug}`, `@qvac/${slug}-${host}`]
      )
    )
  )
  const bci = packages.find((p) => p.name === '@qvac/bci-whispercpp')
  assert.deepEqual(
    bci.native.map(({ name }) => name),
    [join(host, 'qvac__bci-whispercpp.bare')]
  )
  const consumer = installFixture(root, packages)
  verifySpeechPreflight(consumer, { ...CONFIG, host, packages })
})

test('SDK range validation runs before temporary tarball overrides are applied', (t) => {
  const file = join(temporary(t), 'package.json')
  writeJson(file, { dependencies: { '@qvac/asr-ggml': '^0.12.0' } })
  let checked = false
  buildSdk(
    {},
    () => {
      assert.equal(checked, true)
      applyOverrides(file, [{ name: '@qvac/asr-ggml', spec: 'file:/tmp/test.tgz' }])
    },
    (program, args) => {
      assert.equal(program, 'npm')
      assert.equal(JSON.parse(readFileSync(file)).dependencies['@qvac/asr-ggml'], '^0.12.0')
      if (args.join(' ') === 'run build') checked = true
    }
  )
  assert.equal(JSON.parse(readFileSync(file)).dependencies['@qvac/asr-ggml'], 'file:/tmp/test.tgz')
})

test('artifact lookup uses the GitHub API and fails explicitly when a build artifact is missing', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url) => {
    requests.push(url)
    return Promise.resolve(new Response(JSON.stringify({ artifacts: [] })))
  })
  await assert.rejects(
    downloadArtifact({ ...CONFIG, runId: 42 }, {}, 'prebuild-asr-ggml-linux-x64', temporary(t)),
    /requires one available artifact/
  )
  assert.equal(requests.length, 1)
  const url = new URL(requests[0])
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(url.pathname, '/repos/tetherto/qvac/actions/runs/42/artifacts')
  assert.equal(url.searchParams.get('name'), 'prebuild-asr-ggml-linux-x64')
})

test('rejects a bundled addon whose native binary is missing', (t) => {
  const root = temporary(t)
  const host = `${process.platform}-${process.arch}`
  const workdir = packageFixture(root, 'bci-whispercpp', host)
  rmSync(join(workdir, 'prebuilds', host, 'qvac__bci-whispercpp.bare'))
  assert.throws(() => packPackage(workdir, root, host, process.env), /Missing native addon/)
})

test('Windows extraction uses the system ZIP-capable tar and a relative archive path', () => {
  const destination = String.raw`C:\runner work\artifacts\fabric`
  const env = { SystemRoot: String.raw`C:\Windows` }
  const calls = []
  extractArtifact(destination, env, 'win32', (...args) => calls.push(args))
  assert.deepEqual(calls, [
    [String.raw`C:\Windows\System32\tar.exe`, ['-xf', 'artifact.zip'], destination, env]
  ])
  assert.throws(() => extractArtifact(destination, {}, 'win32'), /system directory/)
})

test('Unix extraction resolves the archive in the artifact directory', () => {
  const calls = []
  extractArtifact('/tmp/artifact directory', {}, 'linux', (...args) => calls.push(args))
  assert.deepEqual(calls, [['unzip', ['-q', 'artifact.zip'], '/tmp/artifact directory', {}]])
})

test('collects only fresh Bare crash reports from this run', (t) => {
  const root = temporary(t)
  const source = join(root, 'diagnostics')
  const destination = join(root, 'reports')
  assert.deepEqual(collectNativeCrashes(source, destination, Date.now()), [])
  mkdirSync(source)
  writeFileSync(join(source, 'bare-old.ips'), 'old')
  utimesSync(join(source, 'bare-old.ips'), 0, 0)
  const start = Date.now() - 1000
  writeFileSync(join(source, 'bare-new.ips'), 'stack trace')
  writeFileSync(join(source, 'unrelated.ips'), 'other process')
  assert.deepEqual(collectNativeCrashes(source, destination, start), ['bare-new.ips'])
  assert.equal(readFileSync(join(destination, 'bare-new.ips'), 'utf8'), 'stack trace')
})

test('the preflight replaces every SDK native consumer of Fabric, including non-speech addons', () => {
  const sdk = JSON.parse(
    readFileSync(new URL('../../../packages/sdk/package.json', import.meta.url))
  )
  for (const name of Object.keys(sdk.dependencies).filter((name) => name.startsWith('@qvac/'))) {
    const file = new URL(
      `../../../packages/${name.slice('@qvac/'.length)}/package.json`,
      import.meta.url
    )
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file))
    if (
      manifest.dependencies?.['@qvac/fabric'] ||
      manifest.optionalDependencies?.['@qvac/fabric']
    ) {
      assert.ok(
        PACKAGES.includes(name.slice('@qvac/'.length)),
        `${name} would retain a published binary against the overridden Fabric ABI`
      )
    }
  }
})
