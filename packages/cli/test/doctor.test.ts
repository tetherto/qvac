import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  checkNodeVersion,
  checkCliHost,
  checkTotalMemory,
  checkAvailableMemory,
  checkGpuAcceleration,
  checkFreeDiskSpace,
  checkFfmpeg,
  checkBareRuntime,
  checkBun,
  checkDesktopTargets,
  checkAndroidTarget,
  checkIosTarget,
  checkSdkInstalled,
  collectCheckSections,
  createDefaultContext,
  isReportOk
} from '../src/doctor/checks/index.js'
import type { CheckContext } from '../src/doctor/checks/index.js'

// Build a CheckContext with a minimal, deterministic baseline and spread
// per-test overrides on top. Keeps each test assertion about a single
// variable rather than mocking the whole host.
function makeCtx (overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    projectRoot: process.cwd(),
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '20.11.0',
    totalMemoryBytes: 8 * 1024 ** 3,
    availableMemoryBytes: 4 * 1024 ** 3,
    probe: () => ({ ok: false }),
    ...overrides
  }
}

describe('checkNodeVersion', () => {
  it('fails on Node < 18', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: '16.20.0' }))
    assert.equal(r.status, 'fail')
    assert.equal(r.severity, 'required')
  })

  it('warns on Node 18 (EOL but supported)', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: '18.19.0' }))
    assert.equal(r.status, 'warn')
  })

  it('warns on Node 19 (below recommended)', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: '19.9.0' }))
    assert.equal(r.status, 'warn')
  })

  it('passes on Node 20+', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: '20.11.0' }))
    assert.equal(r.status, 'pass')
  })

  it('handles v-prefixed versions', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: 'v22.1.0' }))
    assert.equal(r.status, 'pass')
  })

  it('warns when version cannot be parsed', () => {
    const r = checkNodeVersion(makeCtx({ nodeVersion: 'nightly' }))
    assert.equal(r.status, 'warn')
  })
})

describe('checkCliHost', () => {
  it('passes on darwin-arm64', () => {
    const r = checkCliHost(makeCtx({ platform: 'darwin', arch: 'arm64' }))
    assert.equal(r.status, 'pass')
    assert.equal(r.value, 'darwin-arm64')
  })

  it('passes on linux-x64', () => {
    const r = checkCliHost(makeCtx({ platform: 'linux', arch: 'x64' }))
    assert.equal(r.status, 'pass')
  })

  it('passes on win32-x64', () => {
    const r = checkCliHost(makeCtx({ platform: 'win32', arch: 'x64' }))
    assert.equal(r.status, 'pass')
  })

  it('fails on unsupported CLI hosts', () => {
    const r = checkCliHost(makeCtx({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64' }))
    assert.equal(r.status, 'fail')
  })

  it('fails on win32-arm64 (not in CLI host matrix)', () => {
    const r = checkCliHost(makeCtx({ platform: 'win32', arch: 'arm64' }))
    assert.equal(r.status, 'fail')
  })

  it('fail hint clarifies that mobile is a deploy target, not a CLI host', () => {
    const r = checkCliHost(makeCtx({ platform: 'android' as NodeJS.Platform, arch: 'arm64' }))
    assert.equal(r.status, 'fail')
    assert.ok(r.hint && /deploy target/i.test(r.hint))
  })
})

describe('checkTotalMemory', () => {
  it('fails when total RAM is below the hard minimum', () => {
    const r = checkTotalMemory(makeCtx({ totalMemoryBytes: 1 * 1024 ** 3 }))
    assert.equal(r.status, 'fail')
  })

  it('warns when total RAM is below recommended', () => {
    const r = checkTotalMemory(makeCtx({ totalMemoryBytes: 3 * 1024 ** 3 }))
    assert.equal(r.status, 'warn')
  })

  it('passes when total RAM meets recommended', () => {
    const r = checkTotalMemory(makeCtx({ totalMemoryBytes: 8 * 1024 ** 3 }))
    assert.equal(r.status, 'pass')
  })

  it("reports severity 'required' across fail/warn/pass branches (severity describes the check, not the outcome)", () => {
    assert.equal(checkTotalMemory(makeCtx({ totalMemoryBytes: 1 * 1024 ** 3 })).severity, 'required')
    assert.equal(checkTotalMemory(makeCtx({ totalMemoryBytes: 3 * 1024 ** 3 })).severity, 'required')
    assert.equal(checkTotalMemory(makeCtx({ totalMemoryBytes: 8 * 1024 ** 3 })).severity, 'required')
  })
})

describe('checkAvailableMemory', () => {
  it('warns when available RAM is below recommended', () => {
    const r = checkAvailableMemory(makeCtx({ availableMemoryBytes: 1 * 1024 ** 3 }))
    assert.equal(r.status, 'warn')
    assert.equal(r.label, 'Available RAM')
  })

  it('passes when available RAM is above recommended', () => {
    const r = checkAvailableMemory(makeCtx({ availableMemoryBytes: 4 * 1024 ** 3 }))
    assert.equal(r.status, 'pass')
  })
})

describe('checkGpuAcceleration', () => {
  it('passes with Metal on darwin (always available)', () => {
    const r = checkGpuAcceleration(makeCtx({ platform: 'darwin', probe: () => ({ ok: false }) }))
    assert.equal(r.status, 'pass')
    assert.ok(r.value && r.value.toLowerCase().includes('metal'))
  })

  it('warns on linux when vulkaninfo is missing', () => {
    const r = checkGpuAcceleration(makeCtx({ platform: 'linux', probe: () => ({ ok: false }) }))
    assert.equal(r.status, 'warn')
    assert.equal(r.severity, 'recommended')
    assert.equal(r.value, 'Vulkan ICD not found')
    assert.ok(r.hint && /vulkan-tools|libvulkan/i.test(r.hint))
  })

  it('warns on win32 when vulkaninfo is missing (with Windows-specific hint)', () => {
    const r = checkGpuAcceleration(makeCtx({ platform: 'win32', probe: () => ({ ok: false }) }))
    assert.equal(r.status, 'warn')
    assert.ok(r.hint && /vulkan sdk|GPU drivers/i.test(r.hint))
  })

  it('passes on linux with a Vulkan ICD, extracting device names', () => {
    const stdout = [
      'VULKANINFO',
      'Vulkan Instance Version: 1.3.268',
      '',
      'GPUs:',
      '=====',
      'GPU0:',
      '\tapiVersion         = 1.3.268',
      '\tdeviceName         = NVIDIA GeForce RTX 3080',
      '\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU'
    ].join('\n')
    const r = checkGpuAcceleration(makeCtx({
      platform: 'linux',
      probe: () => ({ ok: true, stdout })
    }))
    assert.equal(r.status, 'pass')
    assert.ok(r.value && r.value.includes('NVIDIA GeForce RTX 3080'))
  })

  it('passes on linux but hints when vulkaninfo reports no devices', () => {
    const r = checkGpuAcceleration(makeCtx({
      platform: 'linux',
      probe: () => ({ ok: true, stdout: 'VULKANINFO\n' })
    }))
    assert.equal(r.status, 'pass')
    assert.ok(r.hint && /no GPU devices/i.test(r.hint))
  })

  it('is informational on unknown platforms', () => {
    const r = checkGpuAcceleration(makeCtx({ platform: 'freebsd' as NodeJS.Platform, probe: () => ({ ok: false }) }))
    assert.equal(r.status, 'info')
    assert.equal(r.severity, 'informational')
  })
})

describe('checkFreeDiskSpace', () => {
  it('returns a result for the current working directory', () => {
    const r = checkFreeDiskSpace(makeCtx({ projectRoot: process.cwd() }))
    assert.ok(['pass', 'warn', 'skip'].includes(r.status))
    assert.equal(r.severity, 'recommended')
  })
})

describe('optional tool probes', () => {
  const probePresent = () => ({ ok: true, version: '1.2.3' })
  const probeMissing = () => ({ ok: false })

  it('ffmpeg passes when probe reports installed', () => {
    const r = checkFfmpeg(makeCtx({ probe: probePresent }))
    assert.equal(r.status, 'pass')
    assert.equal(r.value, '1.2.3')
  })

  it('ffmpeg warns when probe reports missing', () => {
    const r = checkFfmpeg(makeCtx({ probe: probeMissing }))
    assert.equal(r.status, 'warn')
    assert.ok(r.hint && r.hint.includes('ffmpeg'))
  })

  it('Bare runtime warns when missing (recommended only)', () => {
    const r = checkBareRuntime(makeCtx({ probe: probeMissing }))
    assert.equal(r.status, 'warn')
    assert.equal(r.severity, 'recommended')
  })

  it('Bun warns when missing (recommended only)', () => {
    const r = checkBun(makeCtx({ probe: probeMissing }))
    assert.equal(r.status, 'warn')
    assert.equal(r.severity, 'recommended')
  })
})

describe('deploy-target checks', () => {
  const probePresent = () => ({ ok: true, version: 'Xcode 15.2' })
  const probeMissing = () => ({ ok: false })

  it('desktop targets lists the native host first-class with (native) suffix', () => {
    const r = checkDesktopTargets(makeCtx({ platform: 'linux', arch: 'x64' }))
    assert.equal(r.status, 'pass')
    assert.ok(r.value && r.value.includes('linux-x64 (native)'))
    assert.ok(r.value && r.value.includes('darwin-arm64'))
  })

  it('desktop targets still pass on non-desktop CLI hosts (bare-pack cross-bundles)', () => {
    const r = checkDesktopTargets(makeCtx({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64' }))
    assert.equal(r.status, 'pass')
    assert.ok(r.value && !r.value.includes('(native)'))
  })

  it('android warns when adb is missing', () => {
    const r = checkAndroidTarget(makeCtx({ probe: probeMissing }))
    assert.equal(r.status, 'warn')
    assert.ok(r.hint && /platform-tools|adb/i.test(r.hint))
  })

  it('android passes when adb is present', () => {
    const r = checkAndroidTarget(makeCtx({ probe: probePresent }))
    assert.equal(r.status, 'pass')
  })

  it('iOS is informational (not a warning) on non-darwin hosts', () => {
    const r = checkIosTarget(makeCtx({ platform: 'linux', probe: probeMissing }))
    assert.equal(r.status, 'info')
    assert.equal(r.severity, 'informational')
  })

  it('iOS warns on darwin when Xcode is missing', () => {
    const r = checkIosTarget(makeCtx({ platform: 'darwin', probe: probeMissing }))
    assert.equal(r.status, 'warn')
  })

  it('iOS passes on darwin when Xcode is present', () => {
    const r = checkIosTarget(makeCtx({ platform: 'darwin', probe: probePresent }))
    assert.equal(r.status, 'pass')
    assert.equal(r.value, 'Xcode 15.2')
  })
})

describe('checkSdkInstalled', () => {
  it('warns when @qvac/sdk cannot be resolved from the project', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-check-'))
    try {
      const r = checkSdkInstalled(makeCtx({ projectRoot: emptyDir }))
      assert.equal(r.status, 'warn')
      assert.equal(r.value, 'not found')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('passes when @qvac/sdk is directly installed in node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-check-'))
    const sdkDir = path.join(root, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(sdkDir, { recursive: true })
    fs.writeFileSync(
      path.join(sdkDir, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', version: '0.9.0', main: 'index.js' })
    )
    fs.writeFileSync(path.join(sdkDir, 'index.js'), 'module.exports = {}')
    try {
      const r = checkSdkInstalled(makeCtx({ projectRoot: root }))
      assert.equal(r.status, 'pass')
      assert.equal(r.value, 'v0.9.0')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes when @qvac/sdk is hoisted to a parent node_modules (monorepo case)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-check-'))
    const hoistedSdk = path.join(workspaceRoot, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(hoistedSdk, { recursive: true })
    fs.writeFileSync(
      path.join(hoistedSdk, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', version: '0.9.1', main: 'index.js' })
    )
    fs.writeFileSync(path.join(hoistedSdk, 'index.js'), 'module.exports = {}')

    const nestedProject = path.join(workspaceRoot, 'packages', 'app')
    fs.mkdirSync(nestedProject, { recursive: true })
    fs.writeFileSync(path.join(nestedProject, 'package.json'), JSON.stringify({ name: 'app' }))
    try {
      const r = checkSdkInstalled(makeCtx({ projectRoot: nestedProject }))
      assert.equal(r.status, 'pass', `expected pass, got ${r.status} (value=${r.value ?? ''})`)
      assert.equal(r.value, 'v0.9.1')
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('collectCheckSections + isReportOk', () => {
  it('returns the expected section order and ids', () => {
    const sections = collectCheckSections({ projectRoot: process.cwd() })
    assert.deepEqual(
      sections.map((s) => s.id),
      ['runtime', 'hardware', 'targets', 'tools', 'project']
    )
  })

  it('includes RAM, GPU, and disk checks in the hardware section', () => {
    const sections = collectCheckSections({ projectRoot: process.cwd() })
    const hardware = sections.find((s) => s.id === 'hardware')
    assert.ok(hardware)
    assert.deepEqual(
      hardware.checks.map((c) => c.id),
      ['memory-total', 'memory-available', 'gpu-acceleration', 'disk-free']
    )
  })

  it('includes desktop, android, and ios in the targets section', () => {
    const sections = collectCheckSections({ projectRoot: process.cwd() })
    const targets = sections.find((s) => s.id === 'targets')
    assert.ok(targets)
    assert.deepEqual(
      targets.checks.map((c) => c.id),
      ['target-desktop', 'target-android', 'target-ios']
    )
  })

  it('accepts an explicit CheckContext override for deterministic test runs', () => {
    const sections = collectCheckSections({ context: makeCtx({ probe: () => ({ ok: true, version: 'x' }) }) })
    const tools = sections.find((s) => s.id === 'tools')
    assert.ok(tools)
    assert.ok(tools.checks.every((c) => c.status === 'pass'))
  })

  it('createDefaultContext reflects the live host', () => {
    const ctx = createDefaultContext(process.cwd())
    assert.equal(ctx.platform, process.platform)
    assert.equal(ctx.arch, process.arch)
    assert.equal(ctx.nodeVersion, process.versions.node)
    assert.ok(ctx.totalMemoryBytes > 0)
  })

  it('isReportOk returns false when any check has failed', () => {
    const sections = [
      {
        id: 'runtime' as const,
        title: 'Runtime',
        checks: [
          { id: 'x', label: 'x', status: 'pass' as const, severity: 'required' as const },
          { id: 'y', label: 'y', status: 'fail' as const, severity: 'required' as const }
        ]
      }
    ]
    assert.equal(isReportOk(sections), false)
  })

  it('isReportOk returns true when only warnings/skips/info are present', () => {
    const sections = [
      {
        id: 'runtime' as const,
        title: 'Runtime',
        checks: [
          { id: 'x', label: 'x', status: 'warn' as const, severity: 'required' as const },
          { id: 'y', label: 'y', status: 'skip' as const, severity: 'recommended' as const },
          { id: 'z', label: 'z', status: 'info' as const, severity: 'informational' as const }
        ]
      }
    ]
    assert.equal(isReportOk(sections), true)
  })
})
