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
import { runDoctor } from '../src/doctor/index.js'
import {
  checkSdkRuntime,
  classifySdkRuntimeFailure,
  probeSdkRuntime,
  type SdkRuntimeProbeResult
} from '../src/doctor/deep.js'
import {
  DEEP_PROBE_MESSAGE_KIND,
  DEEP_PROBE_PROTOCOL_VERSION,
  isDeepProbeMessage
} from '../src/doctor/deep-protocol.js'

// Build a CheckContext with a minimal, deterministic baseline and spread
// per-test overrides on top. Keeps each test assertion about a single
// variable rather than mocking the whole host.
function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
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

function createSdkFixture(source: string): { entrypoint: string; projectRoot: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-deep-check-'))
  const sdkDir = path.join(projectRoot, 'node_modules', '@qvac', 'sdk')
  fs.mkdirSync(sdkDir, { recursive: true })
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': './index.js', './package': './package.json' }
    })
  )
  const entrypoint = path.join(sdkDir, 'index.js')
  fs.writeFileSync(entrypoint, source)
  return { entrypoint, projectRoot }
}

function failedProbe(overrides: Partial<SdkRuntimeProbeResult> = {}): SdkRuntimeProbeResult {
  return {
    outcome: 'fail',
    durationMs: 10,
    stdout: '',
    stderr: '',
    exitCode: 1,
    signal: null,
    ...overrides
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isProcessAlive(pid)
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
    assert.equal(
      checkTotalMemory(makeCtx({ totalMemoryBytes: 1 * 1024 ** 3 })).severity,
      'required'
    )
    assert.equal(
      checkTotalMemory(makeCtx({ totalMemoryBytes: 3 * 1024 ** 3 })).severity,
      'required'
    )
    assert.equal(
      checkTotalMemory(makeCtx({ totalMemoryBytes: 8 * 1024 ** 3 })).severity,
      'required'
    )
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
    const r = checkGpuAcceleration(
      makeCtx({
        platform: 'linux',
        probe: () => ({ ok: true, stdout })
      })
    )
    assert.equal(r.status, 'pass')
    assert.ok(r.value && r.value.includes('NVIDIA GeForce RTX 3080'))
  })

  it('passes on linux but hints when vulkaninfo reports no devices', () => {
    const r = checkGpuAcceleration(
      makeCtx({
        platform: 'linux',
        probe: () => ({ ok: true, stdout: 'VULKANINFO\n' })
      })
    )
    assert.equal(r.status, 'pass')
    assert.ok(r.hint && /no GPU devices/i.test(r.hint))
  })

  it('is informational on unknown platforms', () => {
    const r = checkGpuAcceleration(
      makeCtx({ platform: 'freebsd' as NodeJS.Platform, probe: () => ({ ok: false }) })
    )
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

describe('deep SDK runtime probe', () => {
  it('passes after an isolated heartbeat and clean close', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {}
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'pass')
      assert.equal(result.exitCode, 0)
      assert.equal(result.phase, 'close')
      assert.equal(result.probeMessage?.ok, true)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('captures and classifies a native library failure', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {
        throw new Error("version 'GLIBCXX_3.4.30' not found")
      }
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'fail')
      assert.equal(result.phase, 'heartbeat')
      assert.equal(result.probeMessage?.ok, false)
      if (result.probeMessage?.ok === false) {
        assert.match(result.probeMessage.error.message, /GLIBCXX_3\.4\.30/)
      }
      const classification = classifySdkRuntimeFailure(result)
      assert.equal(classification.id, 'libstdcxx')
      assert.match(classification.hint, /may be missing or older/i)

      const check = await checkSdkRuntime(fixture.projectRoot)
      assert.equal(check.code, 'libstdcxx')
      assert.match(check.hint ?? '', /may be missing or older/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('reports a secondary cleanup failure without replacing the heartbeat error', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() { throw new Error('heartbeat failed') }
      export async function close() { throw new Error('cleanup failed') }
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'fail')
      assert.equal(result.phase, 'heartbeat')
      assert.equal(result.probeMessage?.ok, false)
      if (result.probeMessage?.ok === false) {
        assert.match(result.probeMessage.error.message, /heartbeat failed/)
        assert.match(result.probeMessage.cleanupError?.message ?? '', /cleanup failed/)
      }
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('terminates a hung heartbeat at the configured timeout', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {
        await new Promise(() => setInterval(() => {}, 1_000))
      }
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 50
      })
      assert.equal(result.outcome, 'timeout')
      const classification = classifySdkRuntimeFailure(result)
      assert.equal(classification.id, 'worker-handshake-timeout')
      assert.match(classification.hint, /startup handshake/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('bounds a hung close with the cleanup timeout', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {}
      export async function close() {
        await new Promise(() => setInterval(() => {}, 1_000))
      }
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 5_000
      })
      assert.equal(result.outcome, 'fail')
      assert.equal(result.phase, 'close')
      assert.equal(result.probeMessage?.ok, false)
      if (result.probeMessage?.ok === false) {
        assert.equal(result.probeMessage.error.name, 'CleanupTimeoutError')
        assert.match(result.probeMessage.error.message, /2_?000|2000/)
      }
      assert.ok(result.durationMs < 4_500, `close took ${result.durationMs} ms`)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('terminates descendants when a timed-out probe is forced down', async () => {
    const fixture = createSdkFixture(`
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'

      export async function heartbeat() {
        const descendant = spawn(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
          { stdio: 'ignore' }
        )
        writeFileSync(join(process.cwd(), 'descendant.pid'), String(descendant.pid))
        await new Promise(() => setInterval(() => {}, 1_000))
      }
      export async function close() {}
    `)
    let descendantPid: number | undefined
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 1_000
      })
      assert.equal(result.outcome, 'timeout')
      descendantPid = Number(
        fs.readFileSync(path.join(fixture.projectRoot, 'descendant.pid'), 'utf8')
      )
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
      assert.equal(
        await waitForProcessExit(descendantPid, 2_000),
        true,
        `descendant ${descendantPid} survived probe termination`
      )
    } finally {
      if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL')
      }
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('bounds captured output to its tail', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {
        process.stderr.write('x'.repeat(1_000))
        throw new Error('tail marker')
      }
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000,
        maxOutputChars: 512
      })
      assert.ok(result.stderr.length <= 512)
      assert.equal(result.probeMessage?.ok, false)
      if (result.probeMessage?.ok === false) {
        assert.match(result.probeMessage.error.message, /tail marker/)
      }
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('classifies common signal, Bare, Windows runtime, and Vulkan failures', () => {
    assert.match(
      classifySdkRuntimeFailure(failedProbe({ signal: 'SIGILL' })).hint,
      /unsupported by this CPU/i
    )
    assert.match(
      classifySdkRuntimeFailure(failedProbe({ stderr: 'BareRuntimeBinaryNotFoundError' })).hint,
      /Bare runtime binary appears to be missing/i
    )
    assert.match(
      classifySdkRuntimeFailure(failedProbe({ stderr: 'VCRUNTIME140.dll was not found' })).hint,
      /Visual C\+\+ runtime dependency/i
    )
    assert.match(
      classifySdkRuntimeFailure(
        failedProbe({ stderr: 'libnative.so: cannot open shared object file' })
      ).hint,
      /shared-library dependency/i
    )
    assert.match(
      classifySdkRuntimeFailure(failedProbe({ stderr: 'vkCreateInstance failed' })).hint,
      /Vulkan dependency/i
    )
    assert.match(
      classifySdkRuntimeFailure(
        failedProbe({ stderr: 'libvulkan.so.1: cannot open shared object file' })
      ).hint,
      /Vulkan dependency/i
    )
  })

  it('returns stable failure ids in explicit priority order', () => {
    const cases: Array<[SdkRuntimeProbeResult, string]> = [
      [failedProbe({ signal: 'SIGILL' }), 'cpu-instruction'],
      [failedProbe({ stderr: "version 'GLIBCXX_3.4.30' not found" }), 'libstdcxx'],
      [failedProbe({ stderr: 'VCRUNTIME140.dll was not found' }), 'visual-cpp-runtime'],
      [failedProbe({ stderr: 'vkCreateInstance failed' }), 'vulkan'],
      [failedProbe({ stderr: 'libnative.so: cannot open shared object file' }), 'shared-library'],
      [failedProbe({ stderr: 'BareRuntimeBinaryNotFoundError' }), 'bare-runtime'],
      [failedProbe({ outcome: 'timeout' }), 'worker-handshake-timeout'],
      [failedProbe({ outcome: 'spawn-error' }), 'spawn-error'],
      [failedProbe({ outcome: 'protocol-error' }), 'protocol-error'],
      [failedProbe({ phase: 'import' }), 'import-failed'],
      [failedProbe({ phase: 'close' }), 'cleanup-failed'],
      [failedProbe({ phase: 'heartbeat' }), 'heartbeat-failed']
    ]

    for (const [result, expectedId] of cases) {
      assert.equal(classifySdkRuntimeFailure(result).id, expectedId)
    }
  })

  it('classifies import failures separately from heartbeat failures', () => {
    const classification = classifySdkRuntimeFailure(failedProbe({ phase: 'import' }))
    assert.equal(classification.id, 'import-failed')
    assert.match(classification.hint, /could not be imported or initialized/i)
  })

  it('reports a real SDK import-surface failure with the import classification', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'fail')
      assert.equal(result.phase, 'import')
      const classification = classifySdkRuntimeFailure(result)
      assert.equal(classification.id, 'import-failed')
      assert.match(classification.hint, /could not be imported or initialized/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('warns Windows users that a failed deep check may leave a Bare worker', () => {
    const windows = classifySdkRuntimeFailure(failedProbe(), 'win32')
    assert.match(windows.hint, /Bare worker process may still be running/i)
    assert.match(windows.hint, /terminate it manually/i)

    const linux = classifySdkRuntimeFailure(failedProbe(), 'linux')
    assert.doesNotMatch(linux.hint, /may still be running/i)
  })

  it('rejects a protocol failure with a malformed cleanup error', () => {
    assert.equal(
      isDeepProbeMessage({
        kind: DEEP_PROBE_MESSAGE_KIND,
        version: DEEP_PROBE_PROTOCOL_VERSION,
        ok: false,
        phase: 'heartbeat',
        error: { name: 'Error', message: 'heartbeat failed' },
        cleanupError: { name: 'Error', message: 42 }
      }),
      false
    )
    assert.equal(
      isDeepProbeMessage({
        kind: DEEP_PROBE_MESSAGE_KIND,
        version: DEEP_PROBE_PROTOCOL_VERSION,
        ok: true,
        phase: 'close',
        cleanupError: { name: 'Error', message: 'unexpected' }
      }),
      false
    )
  })

  it('prioritizes a concrete SIGILL cause over an RPC timeout wrapper', () => {
    assert.match(
      classifySdkRuntimeFailure(
        failedProbe({ stderr: 'RPCInitTimeoutError: RPC initialization timed out\nsignal SIGILL' })
      ).hint,
      /unsupported by this CPU/i
    )
    assert.equal(
      classifySdkRuntimeFailure(
        failedProbe({ stderr: 'RPCInitTimeoutError: RPC initialization timed out\nsignal SIGILL' })
      ).id,
      'cpu-instruction'
    )
  })

  it('classifies a child-process spawn error', async () => {
    const fixture = createSdkFixture('export async function heartbeat() {}')
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        nodePath: path.join(fixture.projectRoot, 'missing-node'),
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'spawn-error')
      assert.match(classifySdkRuntimeFailure(result).hint, /could not be started/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('adds the deep section to the doctor report', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {}
      export async function close() {}
    `)
    try {
      const report = await runDoctor({ projectRoot: fixture.projectRoot, deep: true, quiet: true })
      const section = report.sections.at(-1)
      assert.equal(section?.id, 'deep')
      assert.equal(section?.checks[0]?.status, 'pass')
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('fails when --deep cannot resolve an SDK entrypoint', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-deep-missing-'))
    try {
      const result = await checkSdkRuntime(projectRoot)
      assert.equal(result.status, 'fail')
      assert.equal(result.severity, 'required')
      assert.equal(result.code, 'sdk-not-found')
      assert.match(result.value ?? '', /not found/i)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects exit code zero without a valid success message', async () => {
    const fixture = createSdkFixture('process.exit(0)')
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'protocol-error')
      assert.match(classifySdkRuntimeFailure(result).hint, /without a valid result/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a success message when the probe exits unsuccessfully', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {
        process.send?.({ kind: '${DEEP_PROBE_MESSAGE_KIND}', version: ${DEEP_PROBE_PROTOCOL_VERSION}, ok: true, phase: 'heartbeat' })
        process.exit(1)
      }
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'protocol-error')
      assert.match(result.error ?? '', /did not agree/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects duplicate protocol result messages', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {
        const result = { kind: '${DEEP_PROBE_MESSAGE_KIND}', version: ${DEEP_PROBE_PROTOCOL_VERSION}, ok: true, phase: 'heartbeat' }
        process.send?.(result)
        process.send?.(result)
        process.exit(0)
      }
      export async function close() {}
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'protocol-error')
      assert.match(result.error ?? '', /duplicate/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('reports close failures separately from heartbeat failures', async () => {
    const fixture = createSdkFixture(`
      export async function heartbeat() {}
      export async function close() { throw new Error('close failed') }
    `)
    try {
      const result = await probeSdkRuntime(fixture.entrypoint, fixture.projectRoot, {
        timeoutMs: 2_000
      })
      assert.equal(result.outcome, 'fail')
      assert.equal(result.phase, 'close')
      assert.match(classifySdkRuntimeFailure(result).hint, /cleanup failed/i)
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true })
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
    const sections = collectCheckSections({
      context: makeCtx({ probe: () => ({ ok: true, version: 'x' }) })
    })
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
