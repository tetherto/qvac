import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  checkNativeLibraries,
  classifyNativeLibraries,
  fabricPreloaded,
  nativeLibraryResults,
  parseNativeDynamic,
  type NativePackage,
  type NativeBinary
} from '@/doctor/native-libraries'
import { isReportOk } from '@/doctor/checks/index'

const binary = (
  needed: string[],
  file = '/package/prebuilds/linux-x64/addon.bare'
): NativeBinary => ({ file, packageRoot: '/package', needed, searchPaths: [] })
const absent = (): Promise<boolean> => Promise.resolve(false)

describe('Linux native prerequisite classification', () => {
  it('reads dynamic entries and gives RUNPATH precedence over RPATH', () => {
    assert.deepEqual(
      parseNativeDynamic(`
 0x1 (NEEDED) Shared library: [libatomic.so.1]
 0xe (SONAME) Library soname: [qvac__fabric-linux-x64@0.bare]
 0xf (RPATH) Library rpath: [/old]
 0x1d (RUNPATH) Library runpath: [$ORIGIN:$ORIGIN/lib]
`),
      {
        needed: ['libatomic.so.1'],
        soname: 'qvac__fabric-linux-x64@0.bare',
        searchPaths: ['$ORIGIN', '$ORIGIN/lib']
      }
    )
    assert.deepEqual(parseNativeDynamic('0xf (RPATH) Library rpath: [${ORIGIN}]').searchPaths, [
      '${ORIGIN}'
    ])
  })

  it('fails a missing required system library and the overall report', async () => {
    const findings = await classifyNativeLibraries([binary(['libatomic.so.1'])], absent, absent)
    assert.deepEqual(findings, { required: ['libatomic.so.1'], optional: [], packages: [] })
    const checks = nativeLibraryResults(findings, 1)
    assert.equal(checks[0]?.code, 'missing-system-library')
    assert.equal(isReportOk([{ id: 'deep', title: 'Deep', checks }]), false)
  })

  it('does not report a library resolved by the loader search paths', async () => {
    const findings = await classifyNativeLibraries(
      [binary(['libbundled.so'])],
      () => Promise.resolve(true),
      absent
    )
    assert.deepEqual(findings, { required: [], optional: [], packages: [] })
  })

  it('does not treat a provider elsewhere in the tree as proof of resolution', async () => {
    const findings = await classifyNativeLibraries(
      [
        binary(['libbundled.so']),
        { ...binary([], '/other/libbundled.so'), soname: 'libbundled.so' }
      ],
      absent,
      absent
    )
    assert.deepEqual(findings, { required: [], optional: [], packages: ['libbundled.so'] })
  })

  it('keeps optional GPU backend requirements out of CPU failures', async () => {
    const findings = await classifyNativeLibraries(
      [binary(['libvulkan.so.1'], '/package/libqvac-ggml-vulkan.so')],
      absent,
      absent
    )
    assert.deepEqual(findings, { required: [], optional: ['libvulkan.so.1'], packages: [] })
    assert.equal(
      isReportOk([{ id: 'deep', title: 'Deep', checks: nativeLibraryResults(findings, 1) }]),
      true
    )
  })

  it('keeps the optional RPC transport out of local CPU requirements', async () => {
    const findings = await classifyNativeLibraries(
      [binary(['libibverbs.so.1'], '/package/libqvac-ggml-rpc.so')],
      absent,
      absent
    )
    assert.deepEqual(findings, { required: [], optional: ['libibverbs.so.1'], packages: [] })
  })

  it('does not downgrade Vulkan when a required addon links it directly', async () => {
    const findings = await classifyNativeLibraries(
      [binary(['libvulkan.so.1']), binary(['libvulkan.so.1'], '/package/libqvac-ggml-vulkan.so')],
      absent,
      absent
    )
    assert.deepEqual(findings, { required: ['libvulkan.so.1'], optional: [], packages: [] })
  })

  it('never offers a system-package remedy for an unresolved Bare SONAME', async () => {
    const soname = 'qvac__fabric@0.bare'
    let systemLookups = 0
    const findings = await classifyNativeLibraries(
      [binary([soname])],
      () => {
        systemLookups++
        return Promise.resolve(false)
      },
      absent
    )
    assert.equal(systemLookups, 0)
    assert.deepEqual(findings, { required: [], optional: [], packages: [soname] })
  })

  it('requires the declared Fabric provider and actual preload, for both package layouts', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-fabric-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const consumer: NativePackage = { root, manifest: { name: '@qvac/consumer' }, dependencies: [] }
    const fabric: NativePackage = {
      root: '/fabric',
      manifest: { name: '@qvac/fabric' },
      dependencies: []
    }
    consumer.dependencies.push(fabric)
    const addon = { ...binary(['qvac__fabric@0.bare']), packageRoot: root }
    const provider = { ...binary([]), packageRoot: fabric.root, soname: 'qvac__fabric@0.bare' }
    await fs.writeFile(
      path.join(root, 'binding.js'),
      "'use strict'\n// preload\nrequire('@qvac/fabric')\nmodule.exports = require.addon()\n"
    )
    assert.equal(
      await fabricPreloaded(addon, provider.soname, [addon, provider], [consumer, fabric]),
      true
    )
    assert.equal(await fabricPreloaded(addon, provider.soname, [addon], [consumer, fabric]), false)
    assert.equal(
      await fabricPreloaded(
        addon,
        provider.soname,
        [addon, provider],
        [{ ...consumer, dependencies: [] }, fabric]
      ),
      false
    )
    const platform = {
      root: '/fabric-linux',
      manifest: { name: '@qvac/fabric-linux-x64' },
      dependencies: []
    }
    const split = {
      ...provider,
      packageRoot: platform.root,
      soname: 'qvac__fabric-linux-x64@0.bare'
    }
    assert.equal(
      await fabricPreloaded(
        addon,
        split.soname,
        [addon, split],
        [consumer, { ...fabric, dependencies: [platform] }, platform]
      ),
      false
    )
    consumer.dependencies = [{ ...fabric, dependencies: [platform] }]
    assert.equal(
      await fabricPreloaded(addon, split.soname, [addon, split], [consumer, fabric, platform]),
      true
    )
    for (const binding of [
      "// require('@qvac/fabric')\nmodule.exports = require.addon()",
      "if (false) require('@qvac/fabric'); module.exports = require.addon()",
      "module.exports = require.addon(); require('@qvac/fabric')"
    ]) {
      await fs.writeFile(path.join(root, 'binding.js'), binding)
      assert.equal(
        await fabricPreloaded(addon, split.soname, [addon, split], [consumer, fabric, platform]),
        false
      )
    }
  })
})

it(
  'checks real ELF RUNPATH resolution and a deliberately missing library',
  { skip: process.platform !== 'linux' },
  async (t) => {
    try {
      execFileSync('cc', ['--version'], { stdio: 'ignore' })
      execFileSync('readelf', ['--version'], { stdio: 'ignore' })
    } catch {
      t.skip('This Linux integration case requires a C compiler and binutils')
      return
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-elf-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const sdk = path.join(root, 'node_modules/@qvac/sdk')
    const prebuild = path.join(sdk, 'addon', 'prebuilds', `linux-${process.arch}`)
    const companion = path.join(prebuild, 'companion')
    await fs.mkdir(companion, { recursive: true })
    await fs.writeFile(
      path.join(sdk, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', main: 'index.js' })
    )
    await fs.writeFile(
      path.join(sdk, 'index.js'),
      'throw new Error("The static check must not import the SDK")'
    )
    const library = path.join(companion, 'libdoctor-fixture.so')
    const source = path.join(root, 'fixture.c')
    await fs.writeFile(source, 'int fixture(void) { return 42; }')
    execFileSync('cc', [
      '-shared',
      '-fPIC',
      '-Wl,-soname,libdoctor-fixture.so',
      '-o',
      library,
      source
    ])
    await fs.writeFile(source, 'extern int fixture(void); int consumer(void) { return fixture(); }')
    execFileSync('cc', [
      '-shared',
      '-fPIC',
      '-o',
      path.join(prebuild, 'addon.bare'),
      source,
      library,
      '-Wl,-rpath,$ORIGIN/companion'
    ])
    // The addon directly needs both libraries; the second has no own RUNPATH.
    const sibling = path.join(companion, 'libdoctor-sibling.so')
    await fs.writeFile(source, 'extern int fixture(void); int sibling(void) { return fixture(); }')
    execFileSync('cc', [
      '-shared',
      '-fPIC',
      '-Wl,-soname,libdoctor-sibling.so',
      '-o',
      sibling,
      source,
      library
    ])
    await fs.writeFile(
      source,
      'extern int fixture(void); extern int sibling(void); int consumer(void) { return fixture() + sibling(); }'
    )
    execFileSync('cc', [
      '-shared',
      '-fPIC',
      '-o',
      path.join(prebuild, 'addon.bare'),
      source,
      library,
      sibling,
      '-Wl,-rpath,$ORIGIN/companion'
    ])
    const resolved = await checkNativeLibraries(root)
    assert.equal(resolved[0]?.status, 'pass', JSON.stringify(resolved))
    assert.equal(resolved.length, 1)
    await fs.unlink(library)
    const missing = await checkNativeLibraries(root)
    assert.equal(missing[0]?.code, 'missing-system-library', JSON.stringify(missing))
    assert.match(missing[0]?.value ?? '', /libdoctor-fixture\.so/)
  }
)
