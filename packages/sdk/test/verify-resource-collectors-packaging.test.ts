import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  acceptResourceCollectorPackaging,
  formatResourceCollectorAcceptanceReport,
  measureTarget,
  RESOURCE_COLLECTOR_SIZE_BUDGETS,
  type ResourceCollectorAcceptanceOptions
} from '@/commands/verify/resource-collectors'
import { listBarePrebuildFiles } from '@/commands/verify/prebuilds'

const COLLECTORS = ['bare-cpu-info', 'bare-gpu-info']

interface FixtureOptions {
  bundleCollectors?: string[]
  manifestCollectors?: string[]
  prebuilds?: Array<{ package: string; host: string; contents?: string; fileName?: string }>
  unrelatedAddon?: boolean
}

interface Fixture {
  options: ResourceCollectorAcceptanceOptions
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-resource-collectors-')))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(filePath: string, value: object) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function escapeForJsString(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function writeBareBundle(bundlePath: string, resolutions: Record<string, boolean>) {
  const bundleId = 'resource-collector-fixture'
  const header = JSON.stringify({ id: bundleId, resolutions })
  const packed = `${bundleId}\n${header}\n`
  fs.writeFileSync(bundlePath, `module.exports = "${escapeForJsString(packed)}"\n`)
}

function createFixture(projectRoot: string, fixtureOptions: FixtureOptions = {}): Fixture {
  const bundleCollectors = fixtureOptions.bundleCollectors ?? COLLECTORS
  const manifestCollectors = fixtureOptions.manifestCollectors ?? COLLECTORS
  const prebuilds =
    fixtureOptions.prebuilds ??
    COLLECTORS.map((packageName) => ({ package: packageName, host: 'linux-x64' }))
  const packageNames = [...COLLECTORS]
  if (fixtureOptions.unrelatedAddon === true) packageNames.push('unrelated-native-addon')

  const packageRoots = new Map<string, string>()
  for (const packageName of packageNames) {
    const packageRoot = path.join(projectRoot, 'node_modules', packageName)
    writeJson(path.join(packageRoot, 'package.json'), {
      name: packageName,
      version: '1.0.0',
      addon: true
    })
    packageRoots.set(packageName, packageRoot)
  }

  for (const prebuild of prebuilds) {
    const packageRoot = packageRoots.get(prebuild.package)
    assert.ok(packageRoot)
    const prebuildPath = path.join(
      packageRoot,
      'prebuilds',
      prebuild.host,
      prebuild.fileName ?? 'collector.bare'
    )
    fs.mkdirSync(path.dirname(prebuildPath), { recursive: true })
    fs.writeFileSync(prebuildPath, prebuild.contents ?? '')
  }

  const resolutions = Object.fromEntries(
    bundleCollectors.map((packageName) => [`/node_modules/${packageName}/index.js`, true])
  )
  if (fixtureOptions.unrelatedAddon === true) {
    resolutions['/node_modules/unrelated-native-addon/index.js'] = true
  }

  const bundlePath = path.join(projectRoot, 'worker.bundle.js')
  writeBareBundle(bundlePath, resolutions)
  const manifestPath = path.join(projectRoot, 'addons.manifest.json')
  writeJson(manifestPath, {
    version: 1,
    bundleId: 'resource-collector-fixture',
    addons:
      fixtureOptions.unrelatedAddon === true
        ? [...manifestCollectors, 'unrelated-native-addon']
        : manifestCollectors
  })

  return {
    options: {
      projectRoot,
      bundlePath,
      manifestPath,
      hosts: ['linux-x64']
    }
  }
}

describe('acceptResourceCollectorPackaging', () => {
  it('reports a collector missing from the generated manifest', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, { manifestCollectors: ['bare-cpu-info'] })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['missing-collector']
      )
      assert.equal(result.issues[0]?.location, 'manifest')
      assert.equal(result.issues[0]?.package, 'bare-gpu-info')
    })
  })

  it('reports a collector missing from the linked bundle graph', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, { bundleCollectors: ['bare-cpu-info'] })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.issues[0]?.code, 'missing-collector')
      assert.equal(result.issues[0]?.location, 'bundle')
      assert.equal(result.issues[0]?.package, 'bare-gpu-info')
    })
  })

  it('reports malformed JSON as an invalid manifest without throwing', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)
      fs.writeFileSync(fixture.options.manifestPath, '{not json\n')

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['invalid-manifest']
      )
    })
  })

  it('reports an invalid manifest shape without throwing', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)
      writeJson(fixture.options.manifestPath, {
        version: 2,
        bundleId: '',
        addons: ['bare-cpu-info', 42]
      })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['invalid-manifest']
      )
    })
  })

  it('passes the prebuild gate when both collectors have active-host assets', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(result.issues, [])
    })
  })

  it('reports a collector missing an active-host prebuild', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [{ package: 'bare-cpu-info', host: 'linux-x64' }]
      })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['missing-prebuild']
      )
      assert.equal(result.issues[0]?.package, 'bare-gpu-info')
      assert.equal(result.issues[0]?.host, 'linux-x64')
    })
  })

  it('ignores assets for an inactive host', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64' },
          { package: 'bare-gpu-info', host: 'darwin-arm64' }
        ]
      })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['missing-prebuild']
      )
      assert.equal(result.issues[0]?.package, 'bare-gpu-info')
      assert.equal(result.issues[0]?.host, 'linux-x64')
    })
  })

  it('does not report unrelated native addons', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, { unrelatedAddon: true })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(result.issues, [])
    })
  })

  it('measures files from both collectors for the requested host', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: 'cpu' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: 'gpu12' },
          {
            package: 'bare-cpu-info',
            host: 'darwin-arm64',
            contents: 'x'.repeat(1024)
          }
        ]
      })
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.ok, true)
      assert.equal(result.targets[0]?.host, 'linux-x64')
      assert.equal(result.targets[0]?.uncompressedBytes, 8)
      assert.deepEqual(
        result.targets[0]?.files.map((file) => ({
          package: file.package,
          relativePath: file.relativePath,
          bytes: file.bytes
        })),
        [
          {
            package: 'bare-cpu-info',
            relativePath: 'prebuilds/linux-x64/collector.bare',
            bytes: 3
          },
          {
            package: 'bare-gpu-info',
            relativePath: 'prebuilds/linux-x64/collector.bare',
            bytes: 5
          }
        ]
      )
      assert.deepEqual(result.budgets, { compressedBytes: 512, uncompressedBytes: 8 })
    })
  })

  it('uses POSIX separators without rewriting valid filename characters', async () => {
    await withTempDir(async (dir) => {
      const cpuFileName = path.sep === path.posix.sep ? 'literal\\collector.bare' : 'collector.bare'
      const fixture = createFixture(dir, {
        prebuilds: [
          {
            package: 'bare-cpu-info',
            host: 'linux-x64',
            fileName: cpuFileName
          },
          { package: 'bare-gpu-info', host: 'linux-x64' }
        ]
      })

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.targets[0]?.files.map((file) => file.relativePath),
        [
          path.sep === path.posix.sep
            ? 'prebuilds/linux-x64/literal\\collector.bare'
            : 'prebuilds/linux-x64/collector.bare',
          'prebuilds/linux-x64/collector.bare'
        ]
      )
    })
  })

  it('reports a dangling collector prebuild as a measurement failure', async (context) => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)
      const packageName = 'bare-cpu-info'
      const prebuildPath = path.join(
        dir,
        'node_modules',
        packageName,
        'prebuilds',
        'linux-x64',
        'collector.bare'
      )
      fs.rmSync(prebuildPath)
      try {
        fs.symlinkSync('missing-collector.bare', prebuildPath)
      } catch (error) {
        context.skip(`symbolic links are unavailable: ${String(error)}`)
        return
      }

      const result = await acceptResourceCollectorPackaging(fixture.options)
      const issue = result.issues.find((candidate) => candidate.code === 'measurement-failed')

      assert.equal(result.ok, false)
      assert.equal(issue?.code, 'measurement-failed')
      assert.equal(issue?.package, packageName)
      assert.equal(issue?.host, 'linux-x64')
    })
  })

  it('rejects promptly when an archive entry fails', async () => {
    const failure = new Error('archive entry failed')
    const measurement = measureTarget(
      'linux-x64',
      [
        {
          package: 'bare-cpu-info',
          relativePath: 'prebuilds/linux-x64/collector.bare',
          bytes: 3,
          contents: Buffer.from('cpu')
        }
      ],
      {
        writeArchiveEntry: async () => {
          throw failure
        }
      }
    )
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('measurement remained pending')), 250)
    })

    await assert.rejects(Promise.race([measurement, timeout]), failure)
  })

  it('passes at the exact uncompressed limit', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: '123' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: '12345' }
        ]
      })
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.ok, true)
      assert.deepEqual(result.issues, [])
    })
  })

  it('reports one byte over the uncompressed limit', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: '1234' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: '12345' }
        ]
      })
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.ok, false)
      assert.deepEqual(result.issues, [
        {
          code: 'uncompressed-budget-exceeded',
          level: 'error',
          host: 'linux-x64',
          actualBytes: 9,
          budgetBytes: 8,
          message: 'linux-x64 resource collectors use 9 uncompressed bytes (limit: 8).'
        }
      ])
    })
  })

  it('reports a compressed archive over its limit', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)
      fixture.options.budgets = { compressedBytes: 1, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.ok, false)
      assert.equal(result.issues[0]?.code, 'compressed-budget-exceeded')
      assert.equal(result.issues[0]?.host, 'linux-x64')
      assert.equal(result.issues[0]?.budgetBytes, 1)
      assert.ok(result.issues[0]?.actualBytes > 1)
    })
  })

  it('passes at the exact measured compressed limit', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir)
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }
      const measurement = await acceptResourceCollectorPackaging(fixture.options)
      const compressedBytes = measurement.targets[0]?.compressedBytes
      assert.ok(compressedBytes !== undefined)
      fixture.options.budgets = { compressedBytes, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.equal(result.ok, true)
      assert.deepEqual(result.issues, [])
      assert.equal(result.targets[0]?.compressedBytes, compressedBytes)
    })
  })

  it('applies totals and budgets independently to each requested host', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: '123' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: '12345' },
          { package: 'bare-cpu-info', host: 'darwin-arm64', contents: '1234' },
          { package: 'bare-gpu-info', host: 'darwin-arm64', contents: '12345' }
        ]
      })
      fixture.options.hosts = ['linux-x64', 'darwin-arm64']
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)

      assert.deepEqual(
        result.targets.map((target) => ({
          host: target.host,
          uncompressedBytes: target.uncompressedBytes
        })),
        [
          { host: 'linux-x64', uncompressedBytes: 8 },
          { host: 'darwin-arm64', uncompressedBytes: 9 }
        ]
      )
      assert.deepEqual(
        result.issues.map((issue) => ({
          code: issue.code,
          host: 'host' in issue ? issue.host : undefined
        })),
        [{ code: 'uncompressed-budget-exceeded', host: 'darwin-arm64' }]
      )
    })
  })

  it('serializes and formats successful measurements deterministically', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: 'cpu' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: 'gpu' }
        ]
      })

      const first = await acceptResourceCollectorPackaging(fixture.options)
      const second = await acceptResourceCollectorPackaging(fixture.options)
      const output = formatResourceCollectorAcceptanceReport(first)

      assert.equal(JSON.stringify(first), JSON.stringify(second))
      assert.match(output, /^Resource collector packaging: PASS$/m)
      assert.match(
        output,
        new RegExp(
          `^linux-x64: ${first.targets[0]?.compressedBytes} compressed / 6 uncompressed$`,
          'm'
        )
      )
      assert.match(
        output,
        new RegExp('^Budgets: 2\\.00 MiB compressed / 5\\.00 MiB uncompressed$', 'm')
      )
      assert.deepEqual(first.budgets, RESOURCE_COLLECTOR_SIZE_BUDGETS)
    })
  })

  it('formats budget failures with issue details', async () => {
    await withTempDir(async (dir) => {
      const fixture = createFixture(dir, {
        prebuilds: [
          { package: 'bare-cpu-info', host: 'linux-x64', contents: '1234' },
          { package: 'bare-gpu-info', host: 'linux-x64', contents: '12345' }
        ]
      })
      fixture.options.budgets = { compressedBytes: 512, uncompressedBytes: 8 }

      const result = await acceptResourceCollectorPackaging(fixture.options)
      const output = formatResourceCollectorAcceptanceReport(result)

      assert.match(output, /^Resource collector packaging: FAIL$/m)
      assert.match(
        output,
        /uncompressed-budget-exceeded.*linux-x64.*actual: 9 bytes.*limit: 8 bytes/
      )
    })
  })
})

describe('listBarePrebuildFiles', () => {
  it('returns sorted absolute paths for direct .bare files only', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'z.bare'), '')
      fs.writeFileSync(path.join(dir, 'a.bare'), '')
      fs.writeFileSync(path.join(dir, 'readme.txt'), '')
      fs.mkdirSync(path.join(dir, 'nested'))
      fs.writeFileSync(path.join(dir, 'nested', 'ignored.bare'), '')

      const files = await listBarePrebuildFiles(dir)

      assert.deepEqual(files, [path.join(dir, 'a.bare'), path.join(dir, 'z.bare')])
    })
  })

  it('returns an empty list when the host directory cannot be read', async () => {
    await withTempDir(async (dir) => {
      assert.deepEqual(await listBarePrebuildFiles(path.join(dir, 'missing')), [])
    })
  })
})
