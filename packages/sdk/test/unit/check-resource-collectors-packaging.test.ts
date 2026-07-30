import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BundleSdkOptions, BundleSdkResult } from '@/commands/bundle/index'
import type {
  ResourceCollectorAcceptanceOptions,
  ResourceCollectorAcceptanceReport
} from '@/commands/verify/resource-collectors'
import {
  parseResourceCollectorCheckArgs,
  resolveDesktopHost,
  runResourceCollectorPackagingCli,
  runResourceCollectorPackagingCheck,
  type ResourceCollectorCheckDependencies
} from '@/scripts/check-resource-collectors-packaging'
import { RequestValidationFailedError } from '@/utils/errors-client'

const REPORT: ResourceCollectorAcceptanceReport = {
  ok: true,
  collectors: ['bare-cpu-info', 'bare-gpu-info'],
  hosts: ['linux-x64'],
  budgets: {
    compressedBytes: 2 * 1024 * 1024,
    uncompressedBytes: 5 * 1024 * 1024
  },
  targets: [],
  issues: []
}

const BUNDLE: BundleSdkResult = {
  bundlePath: '/tmp/project/qvac/worker.bundle.js',
  plugins: [],
  addons: ['bare-cpu-info', 'bare-gpu-info'],
  entryPaths: { worker: '/tmp/project/qvac/worker.entry.mjs' },
  manifestPath: '/tmp/project/qvac/addons.manifest.json'
}

describe('parseResourceCollectorCheckArgs', () => {
  it('parses repeatable hosts and JSON output', () => {
    assert.deepEqual(
      parseResourceCollectorCheckArgs(['--host', 'linux-x64', '--json', '--host', 'darwin-arm64']),
      {
        hosts: ['linux-x64', 'darwin-arm64'],
        json: true
      }
    )
  })

  it('deduplicates hosts while preserving first-seen order', () => {
    assert.deepEqual(
      parseResourceCollectorCheckArgs([
        '--host',
        'linux-x64',
        '--host',
        'darwin-arm64',
        '--host',
        'linux-x64'
      ]).hosts,
      ['linux-x64', 'darwin-arm64']
    )
  })

  it('rejects a host flag without a value using a structured SDK error', () => {
    assert.throws(() => parseResourceCollectorCheckArgs(['--host']), RequestValidationFailedError)
  })

  it('rejects unknown arguments using a structured SDK error', () => {
    assert.throws(
      () => parseResourceCollectorCheckArgs(['--verbose']),
      RequestValidationFailedError
    )
  })

  it('rejects unsupported requested hosts using a structured SDK error', () => {
    assert.throws(
      () => parseResourceCollectorCheckArgs(['--host', 'android-arm64']),
      RequestValidationFailedError
    )
  })
})

describe('resolveDesktopHost', () => {
  it('maps supported Node platforms and architectures', () => {
    assert.equal(resolveDesktopHost('darwin', 'arm64'), 'darwin-arm64')
    assert.equal(resolveDesktopHost('darwin', 'x64'), 'darwin-x64')
    assert.equal(resolveDesktopHost('linux', 'arm64'), 'linux-arm64')
    assert.equal(resolveDesktopHost('linux', 'x64'), 'linux-x64')
    assert.equal(resolveDesktopHost('win32', 'arm64'), 'win32-arm64')
    assert.equal(resolveDesktopHost('win32', 'x64'), 'win32-x64')
  })

  it('rejects unsupported combinations using a structured SDK error', () => {
    assert.throws(() => resolveDesktopHost('linux', 'riscv64'), RequestValidationFailedError)
    assert.throws(() => resolveDesktopHost('freebsd', 'x64'), RequestValidationFailedError)
  })
})

describe('runResourceCollectorPackagingCheck', () => {
  it('bundles a temporary project and checks only requested hosts', async () => {
    const bundleCalls: BundleSdkOptions[] = []
    const acceptanceCalls: ResourceCollectorAcceptanceOptions[] = []
    const outputs: string[] = []
    const removed: string[] = []
    const linkedSdkRoots: string[] = []
    const dependencies = createDependencies({
      createTemporaryProject: async (sdkPackageRoot) => {
        linkedSdkRoots.push(sdkPackageRoot)
        return '/tmp/project'
      },
      bundleSdk: async (options) => {
        bundleCalls.push(options)
        return BUNDLE
      },
      acceptResourceCollectorPackaging: async (options) => {
        acceptanceCalls.push(options)
        return REPORT
      },
      writeOutput: (output) => outputs.push(output),
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      }
    })

    await runResourceCollectorPackagingCheck(
      {
        sdkPackageRoot: '/repo/packages/sdk',
        hosts: ['linux-x64'],
        json: true
      },
      dependencies
    )

    assert.deepEqual(linkedSdkRoots, ['/repo/packages/sdk'])
    assert.deepEqual(bundleCalls, [
      {
        projectRoot: '/tmp/project',
        sdkPath: '/repo/packages/sdk',
        hosts: ['linux-x64'],
        quiet: true
      }
    ])
    assert.deepEqual(acceptanceCalls, [
      {
        projectRoot: '/tmp/project',
        bundlePath: BUNDLE.bundlePath,
        manifestPath: BUNDLE.manifestPath,
        hosts: ['linux-x64']
      }
    ])
    assert.deepEqual(outputs, [JSON.stringify(REPORT, null, 2)])
    assert.deepEqual(removed, ['/tmp/project'])
  })

  it('uses the active host and human formatter when hosts are omitted', async () => {
    const hosts: string[][] = []
    const outputs: string[] = []
    const dependencies = createDependencies({
      acceptResourceCollectorPackaging: async (options) => {
        hosts.push(options.hosts)
        return REPORT
      },
      formatResourceCollectorAcceptanceReport: () => 'human report',
      writeOutput: (output) => outputs.push(output)
    })

    await runResourceCollectorPackagingCheck(
      {
        sdkPackageRoot: '/repo/packages/sdk',
        hosts: [],
        json: false,
        platform: 'darwin',
        arch: 'arm64'
      },
      dependencies
    )

    assert.deepEqual(hosts, [['darwin-arm64']])
    assert.deepEqual(outputs, ['human report'])
  })

  it('sets a failing exit code and still removes the temporary project', async () => {
    const exitCodes: number[] = []
    const removed: string[] = []
    const dependencies = createDependencies({
      acceptResourceCollectorPackaging: async () => ({ ...REPORT, ok: false }),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      }
    })

    await runResourceCollectorPackagingCheck(
      {
        sdkPackageRoot: '/repo/packages/sdk',
        hosts: ['linux-x64'],
        json: false
      },
      dependencies
    )

    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(removed, ['/tmp/project'])
  })

  it('removes the temporary project when bundling throws', async () => {
    const removed: string[] = []
    const failure = new RequestValidationFailedError('bundle failed')
    const dependencies = createDependencies({
      bundleSdk: async () => {
        throw failure
      },
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      }
    })

    await assert.rejects(
      runResourceCollectorPackagingCheck(
        {
          sdkPackageRoot: '/repo/packages/sdk',
          hosts: ['linux-x64'],
          json: false
        },
        dependencies
      ),
      failure
    )
    assert.deepEqual(removed, ['/tmp/project'])
  })

  it('removes the temporary project when acceptance throws', async () => {
    const removed: string[] = []
    const failure = new RequestValidationFailedError('acceptance failed')
    const dependencies = createDependencies({
      acceptResourceCollectorPackaging: async () => {
        throw failure
      },
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      }
    })

    await assert.rejects(
      runResourceCollectorPackagingCheck(
        {
          sdkPackageRoot: '/repo/packages/sdk',
          hosts: ['linux-x64'],
          json: false
        },
        dependencies
      ),
      failure
    )
    assert.deepEqual(removed, ['/tmp/project'])
  })
})

describe('runResourceCollectorPackagingCli', () => {
  it('reports argument failures without rejecting', async () => {
    const errors: string[] = []
    const exitCodes: number[] = []
    const dependencies = createDependencies({
      writeError: (output) => errors.push(output),
      setExitCode: (exitCode) => exitCodes.push(exitCode)
    })

    await runResourceCollectorPackagingCli(['--unknown'], {
      sdkPackageRoot: '/repo/packages/sdk',
      dependencies
    })

    assert.deepEqual(errors, [
      'Resource collector packaging check failed: Unknown argument: --unknown'
    ])
    assert.deepEqual(exitCodes, [1])
  })

  it('reports bundle failures and preserves temporary-project cleanup', async () => {
    const errors: string[] = []
    const exitCodes: number[] = []
    const removed: string[] = []
    const dependencies = createDependencies({
      bundleSdk: async () => {
        throw new RequestValidationFailedError('bundle failed')
      },
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      },
      writeError: (output) => errors.push(output),
      setExitCode: (exitCode) => exitCodes.push(exitCode)
    })

    await runResourceCollectorPackagingCli(['--host', 'linux-x64'], {
      sdkPackageRoot: '/repo/packages/sdk',
      dependencies
    })

    assert.deepEqual(errors, ['Resource collector packaging check failed: bundle failed'])
    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(removed, ['/tmp/project'])
  })

  it('reports acceptance failures and preserves temporary-project cleanup', async () => {
    const errors: string[] = []
    const exitCodes: number[] = []
    const removed: string[] = []
    const dependencies = createDependencies({
      acceptResourceCollectorPackaging: async () => {
        throw new RequestValidationFailedError('acceptance failed')
      },
      removeTemporaryProject: async (projectRoot) => {
        removed.push(projectRoot)
      },
      writeError: (output) => errors.push(output),
      setExitCode: (exitCode) => exitCodes.push(exitCode)
    })

    await runResourceCollectorPackagingCli(['--host', 'linux-x64'], {
      sdkPackageRoot: '/repo/packages/sdk',
      dependencies
    })

    assert.deepEqual(errors, ['Resource collector packaging check failed: acceptance failed'])
    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(removed, ['/tmp/project'])
  })

  it('reports temporary-project cleanup failures without rejecting', async () => {
    const errors: string[] = []
    const exitCodes: number[] = []
    const dependencies = createDependencies({
      removeTemporaryProject: async () => {
        throw new RequestValidationFailedError('cleanup failed')
      },
      writeError: (output) => errors.push(output),
      setExitCode: (exitCode) => exitCodes.push(exitCode)
    })

    await runResourceCollectorPackagingCli(['--host', 'linux-x64'], {
      sdkPackageRoot: '/repo/packages/sdk',
      dependencies
    })

    assert.deepEqual(errors, ['Resource collector packaging check failed: cleanup failed'])
    assert.deepEqual(exitCodes, [1])
  })
})

function createDependencies(
  overrides: Partial<ResourceCollectorCheckDependencies>
): ResourceCollectorCheckDependencies {
  return {
    createTemporaryProject: async () => '/tmp/project',
    removeTemporaryProject: async () => {},
    bundleSdk: async () => BUNDLE,
    acceptResourceCollectorPackaging: async () => REPORT,
    formatResourceCollectorAcceptanceReport: () => 'formatted report',
    writeOutput: () => {},
    writeError: () => {},
    setExitCode: () => {},
    ...overrides
  }
}
