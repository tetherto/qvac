import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  classifyNativeLibraries,
  hostElf,
  nativeLibraryResults,
  packageProvides,
  parseNativeDynamic,
  readNativeDynamic,
  resolvesFrom,
  type NativePackage,
  type NativeBinary
} from '@/doctor/native-libraries'
import { combineDeepChecks } from '@/doctor/deep'
import { isReportOk } from '@/doctor/checks/index'
import { resolvePackageJson } from '@/doctor/checks/project'
import type { CheckResult } from '@/doctor/types'

const packageRoot = path.resolve('fixture-package')
const binary = (needed: string[], file = path.join(packageRoot, 'addon.bare')): NativeBinary => ({
  file,
  packageRoot,
  packageName: 'fixture-package',
  needed,
  searchPaths: []
})
const absent = (): Promise<boolean> => Promise.resolve(false)
const finding = (name: string, ...requesters: NativeBinary[]) => ({
  name,
  requiredBy: requesters.map((entry) => ({
    package: entry.packageName,
    file: path.relative(entry.packageRoot, entry.file)
  }))
})
const dynamicOutput = `
 0x0000000000000001 (NEEDED)             Shared library: [libatomic.so.1]
 0x000000000000000e (SONAME)             Library soname: [vendor__runtime@3.bare]
 0x000000000000000f (RPATH)              Library rpath: [/old]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN:$ORIGIN/lib]
`

describe('native metadata and loader paths', () => {
  it('reads recorded dynamic entries with RUNPATH precedence over RPATH', async () => {
    const result = await readNativeDynamic('addon.bare', async (program, args) => {
      assert.equal(program, 'readelf')
      assert.deepEqual(args, ['-d', '--wide', '--', 'addon.bare'])
      return dynamicOutput
    })
    assert.deepEqual(result, {
      needed: ['libatomic.so.1'],
      soname: 'vendor__runtime@3.bare',
      searchPaths: ['$ORIGIN', '$ORIGIN/lib']
    })
    assert.deepEqual(parseNativeDynamic('0xf (RPATH) Library rpath: [${ORIGIN}]').searchPaths, [
      '${ORIGIN}'
    ])
    assert.deepEqual(
      parseNativeDynamic('0xf (RPATH) Library rpath: [/old]\n0x1d (RUNPATH) Library runpath: []')
        .searchPaths,
      ['']
    )
    assert.deepEqual(parseNativeDynamic('There is no dynamic section in this file.'), {
      needed: [],
      soname: undefined,
      searchPaths: []
    })
    await assert.rejects(
      readNativeDynamic('addon.bare', async () => {
        throw new Error('readelf failed')
      }),
      /readelf failed/
    )
  })

  it('identifies ELF headers without a compiler or host-native executable', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-header-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const file = path.join(root, 'header')
    const header = Buffer.alloc(20)
    header.set([127, 69, 76, 70, 2, 1])
    for (const [arch, machine, other] of [
      ['x64', 62, 'arm64'],
      ['arm64', 183, 'x64']
    ] as const) {
      header.writeUInt16LE(machine, 18)
      await fs.writeFile(file, header)
      assert.equal(await hostElf(file, arch), true)
      assert.equal(await hostElf(file, other), false)
      assert.equal(await hostElf(file, 'riscv64'), false)
    }
    for (const [offset, value] of [
      [0, 0],
      [4, 1],
      [5, 2]
    ] as const) {
      const invalid = Buffer.from(header)
      invalid[offset] = value
      await fs.writeFile(file, invalid)
      assert.equal(await hostElf(file, 'arm64'), false)
    }
    await fs.writeFile(file, header.subarray(0, 19))
    assert.equal(await hostElf(file, 'arm64'), false)
    assert.equal(await hostElf(path.join(root, 'missing'), 'x64'), false)
  })

  it('uses injected loader paths, recorded RUNPATH and cache without host I/O', async () => {
    const addon = { ...binary(['libatomic.so.1']), ...parseNativeDynamic(dynamicOutput) }
    const projectRoot = path.resolve('project')
    const env = path.resolve('env')
    const defaults = path.resolve('defaults')
    const cached = path.resolve('cache/libatomic.so.1')
    const expected = [
      path.join(env, 'libatomic.so.1'),
      path.join(packageRoot, 'libatomic.so.1'),
      path.join(packageRoot, 'lib/libatomic.so.1'),
      path.join(defaults, 'libatomic.so.1'),
      cached
    ]
    for (const hit of [...expected, undefined]) {
      const visited: string[] = []
      const result = await resolvesFrom(addon, 'libatomic.so.1', {
        projectRoot,
        dirs: [defaults],
        libraryPath: env,
        cache: new Map([['libatomic.so.1', [cached]]]),
        exists: async (file) => {
          visited.push(file)
          return file === hit
        }
      })
      assert.equal(result, hit !== undefined)
      assert.deepEqual(
        visited,
        hit === undefined ? expected : expected.slice(0, expected.indexOf(hit) + 1)
      )
    }
  })

  it('handles RPATH, relative and slash-qualified names without searching unrelated dirs', async () => {
    const projectRoot = path.resolve('project')
    const addon = {
      ...binary([]),
      ...parseNativeDynamic('0xf (RPATH) Library rpath: [${ORIGIN}/libs]')
    }
    const visited: string[] = []
    const inputs = {
      projectRoot,
      dirs: [],
      cache: new Map<string, string[]>(),
      exists: async (file: string) => {
        visited.push(file)
        return true
      }
    }
    assert.equal(await resolvesFrom(addon, 'libtest.so', inputs), true)
    assert.deepEqual(visited.splice(0), [path.join(packageRoot, 'libs/libtest.so')])
    assert.equal(await resolvesFrom(addon, '$ORIGIN/libs/libtest.so', inputs), true)
    assert.deepEqual(visited.splice(0), [path.join(packageRoot, 'libs/libtest.so')])
    assert.equal(await resolvesFrom(addon, 'relative/libtest.so', inputs), true)
    assert.deepEqual(visited.splice(0), [path.join(projectRoot, 'relative/libtest.so')])
    assert.equal(await resolvesFrom(binary([]), 'libtest.so', { ...inputs, libraryPath: '' }), true)
    assert.deepEqual(visited, [path.join(projectRoot, 'libtest.so')])
  })

  it('reports unsupported loader tokens instead of guessing', async () => {
    const inputs = {
      projectRoot: packageRoot,
      dirs: [],
      cache: new Map<string, string[]>(),
      exists: absent
    }
    await assert.rejects(
      resolvesFrom(binary([]), 'libtest.so', { ...inputs, libraryPath: '$ORIGIN' }),
      /Unsupported dynamic-loader/
    )
    await assert.rejects(
      resolvesFrom({ ...binary([]), searchPaths: ['$LIB'] }, 'libtest.so', inputs),
      /Unsupported dynamic-loader/
    )
  })

  it('resolves manifests shared by the project check and dependency scan', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-package-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    for (const [name, exports] of [
      ['fixture-json', { './package.json': './package.json' }],
      ['fixture-alias', { './package': './package.json' }],
      ['fixture-entry', { '.': './dist/index.js' }]
    ] as const) {
      const dir = path.join(root, 'node_modules', name)
      await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, exports }))
      await fs.writeFile(path.join(dir, 'dist/index.js'), 'throw new Error("must not execute")')
      assert.equal(resolvePackageJson(root, name), path.join(dir, 'package.json'))
    }
    assert.equal(resolvePackageJson(root, 'fixture-missing'), null)
  })
})

describe('native prerequisite classification', () => {
  it('keeps every requester with a required library and renders it', async () => {
    const a = binary(['libatomic.so.1', 'libatomic.so.1'])
    const b = {
      ...binary(['libatomic.so.1'], path.join(packageRoot, 'other.bare')),
      packageName: '@qvac/plugin'
    }
    const findings = await classifyNativeLibraries([a, b], absent, absent)
    assert.deepEqual(findings, {
      required: [finding('libatomic.so.1', a, b)],
      optional: [],
      packages: []
    })
    const checks = nativeLibraryResults(findings, 2)
    assert.equal(checks[0]?.code, 'missing-system-library')
    assert.match(
      checks[0]?.value ?? '',
      /libatomic\.so\.1 \(fixture-package\/addon.bare, @qvac\/plugin\/other.bare\)/
    )
    assert.equal(isReportOk([{ id: 'deep', title: 'Deep', checks }]), false)
  })

  it('does not report a library resolved by the loader', async () => {
    assert.deepEqual(
      await classifyNativeLibraries([binary(['libbundled.so'])], async () => true, absent),
      { required: [], optional: [], packages: [] }
    )
  })

  it('keeps unresolved package libraries separate from system prerequisites', async () => {
    const addon = binary(['libbundled.so'])
    const findings = await classifyNativeLibraries(
      [
        addon,
        {
          ...binary([], path.join(packageRoot, 'elsewhere/libbundled.so')),
          soname: 'libbundled.so'
        }
      ],
      absent,
      absent
    )
    assert.deepEqual(findings, {
      required: [],
      optional: [],
      packages: [finding('libbundled.so', addon)]
    })
    assert.match(nativeLibraryResults(findings, 2)[1]?.value ?? '', /fixture-package\/addon.bare/)
  })

  for (const backend of ['vulkan', 'rpc', 'new-backend']) {
    it(`recognizes optional ${backend} by layout instead of a backend-name list`, async () => {
      const addon = binary(
        ['libdriver.so'],
        path.join(packageRoot, `prebuilds/linux-x64/qvac__runtime/libggml-${backend}.so`)
      )
      const findings = await classifyNativeLibraries([addon], absent, absent)
      assert.deepEqual(findings, {
        required: [],
        optional: [finding('libdriver.so', addon)],
        packages: []
      })
      assert.equal(
        isReportOk([{ id: 'deep', title: 'Deep', checks: nativeLibraryResults(findings, 1) }]),
        true
      )
      assert.match(nativeLibraryResults(findings, 1)[1]?.value ?? '', /fixture-package/)
    })
  }

  it('does not downgrade a linked backend or a library also needed by a module', async () => {
    const backend = binary(['libdriver.so'], path.join(packageRoot, 'qvac__runtime/libggml-new.so'))
    const parent = binary(['libggml-new.so'])
    const linked = await classifyNativeLibraries([parent, backend], absent, absent)
    assert.deepEqual(linked.required, [finding('libdriver.so', backend)])
    assert.deepEqual(linked.optional, [])
    const module = binary(['libdriver.so'])
    const shared = await classifyNativeLibraries([module, backend], absent, absent)
    assert.deepEqual(shared.required, [finding('libdriver.so', module, backend)])
    assert.deepEqual(shared.optional, [])
    const outsideLayout = binary(['libdriver.so'], path.join(packageRoot, 'libggml-new.so'))
    assert.deepEqual((await classifyNativeLibraries([outsideLayout], absent, absent)).required, [
      finding('libdriver.so', outsideLayout)
    ])
  })

  it('never offers a system-package remedy for an unresolved Bare SONAME', async () => {
    const addon = binary(['vendor__runtime@3.bare'])
    const findings = await classifyNativeLibraries(
      [addon],
      async () => {
        assert.fail('Bare SONAME must not use system lookup')
      },
      absent
    )
    assert.deepEqual(findings, {
      required: [],
      optional: [],
      packages: [finding('vendor__runtime@3.bare', addon)]
    })
  })

  it('resolves arbitrary ABI SONAMEs only in the requester dependency closure', () => {
    const pkg = (name: string): NativePackage => ({
      root: path.resolve(name),
      manifest: { name },
      dependencies: []
    })
    const consumer = pkg('consumer'),
      runtime = pkg('runtime'),
      vendor = pkg('vendor')
    consumer.dependencies = [runtime]
    runtime.dependencies = [vendor]
    vendor.dependencies = [runtime] // cycles must terminate
    const addon = {
      ...binary(['vendor__runtime-linux-arm64-cuda@3.bare']),
      packageRoot: consumer.root
    }
    const provider = { ...binary([]), packageRoot: vendor.root, soname: addon.needed[0]! }
    assert.equal(
      packageProvides(addon, provider.soname, [addon, provider], [consumer, runtime, vendor]),
      true
    )
    assert.equal(
      packageProvides(
        addon,
        'vendor__runtime-linux-arm64-cuda@4.bare',
        [addon, provider],
        [consumer, runtime, vendor]
      ),
      false
    )
    assert.equal(
      packageProvides(addon, provider.soname, [addon], [consumer, runtime, vendor]),
      false
    )
    assert.equal(
      packageProvides(
        addon,
        provider.soname,
        [addon, provider],
        [{ ...consumer, dependencies: [] }, runtime, vendor]
      ),
      false
    )
    assert.equal(
      packageProvides(addon, provider.soname, [addon, provider], [runtime, vendor]),
      false
    )
  })
})

describe('static scan and heartbeat result', () => {
  const runtime: CheckResult = {
    id: 'sdk-runtime',
    label: 'Heartbeat',
    status: 'pass',
    severity: 'required'
  }
  it('warns on static misses when the worker runs and preserves JSON heartbeat position', async () => {
    const checks = nativeLibraryResults(
      await classifyNativeLibraries([binary(['libplugin.so'])], absent, absent),
      1
    )
    const section = combineDeepChecks(checks, runtime)
    assert.equal(section.checks[0], runtime)
    assert.equal(section.checks[1]?.status, 'warn')
    assert.match(section.checks[1]?.value ?? '', /fixture-package\/addon.bare/)
    assert.match(section.checks[1]?.hint ?? '', /heartbeat passed/)
    assert.equal(isReportOk([section]), true)
    assert.equal(checks[0]?.status, 'fail', 'does not mutate the original finding')
  })
  it('retains failures when the heartbeat fails', async () => {
    const checks = nativeLibraryResults(
      await classifyNativeLibraries([binary(['libatomic.so.1'])], absent, absent),
      1
    )
    const section = combineDeepChecks(checks, { ...runtime, status: 'fail' })
    assert.equal(section.checks[1]?.status, 'fail')
    assert.equal(isReportOk([section]), false)
  })
  it('keeps skipped scans and their explanation without replacing the heartbeat', () => {
    const skipped: CheckResult = {
      id: 'native-libraries',
      label: 'Native libraries',
      status: 'skip',
      severity: 'recommended',
      value: 'Linux x64/arm64 only'
    }
    assert.deepEqual(combineDeepChecks([skipped], runtime).checks, [runtime, skipped])
  })
})
