import { expect, test } from 'bun:test'
import { chmod, mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Harness from './internal-sandbox-surface.ts'

test('Seatbelt profile output is deterministic and narrowly scoped', () => {
  const createPolicy = Reflect.get(Harness, 'createMacOsSandboxPolicy')
  const renderProfile = Reflect.get(Harness, 'renderSeatbeltProfile')
  expect(typeof createPolicy).toBe('function')
  expect(typeof renderProfile).toBe('function')
  if (typeof createPolicy !== 'function' || typeof renderProfile !== 'function') return

  const first = createPolicy({
    bareExecutable: '/private/app/Bare Runtime/bare',
    childEntry: '/private/app/tool-child.bundle',
    codeRoots: ['/private/app'],
    resourceRoots: ['/private/resources/z', '/private/resources/a'],
    executablePaths: ['/usr/local/bin/obsidian'],
    readOnlyRoots: ['/private/read-only'],
    writeRoots: ['/private/write'],
    scratchRoot: '/private/scratch',
    loopbackPorts: [43123]
  })
  const second = createPolicy({
    bareExecutable: '/private/app/Bare Runtime/bare',
    childEntry: '/private/app/tool-child.bundle',
    codeRoots: ['/private/app'],
    resourceRoots: ['/private/resources/a', '/private/resources/z'],
    executablePaths: ['/usr/local/bin/obsidian'],
    readOnlyRoots: ['/private/read-only'],
    writeRoots: ['/private/write'],
    scratchRoot: '/private/scratch',
    loopbackPorts: [43123]
  })
  const profile = renderProfile(first)

  expect(profile).toBe(renderProfile(second))
  expect(profile.startsWith('(version 1)\n(deny default)\n')).toBe(true)
  expect(profile).toContain(
    '(allow signal (target self) (target children))'
  )
  expect(profile).toContain('(literal "/private/app/Bare Runtime/bare")')
  expect(profile).toContain('(subpath "/private/resources/a")')
  expect(profile).toContain('(subpath "/private/resources/z")')
  const executableMapRule =
    profile.match(/\(allow file-map-executable[\s\S]*?\n\)/)?.[0] ?? ''
  expect(executableMapRule).toContain('(subpath "/private/app")')
  expect(executableMapRule).not.toContain('/private/resources')
  expect(executableMapRule).not.toContain('/private/read-only')
  expect(executableMapRule).not.toContain('/private/write')
  expect(executableMapRule).not.toContain('/private/scratch')
  expect(profile).toContain('(remote ip "localhost:43123")')
  expect(profile).not.toContain('(remote ip "localhost:*")')
  expect(profile).not.toContain('(import "system.sb")')
  expect(profile).not.toContain('(allow network*)')
  expect(profile).not.toContain('(allow network-inbound')
  expect(profile).not.toContain('(allow mach-lookup')
  expect(profile).not.toContain('(allow ipc-posix')
  expect(profile).not.toContain('(allow file-read*)\n')
  expect(profile).not.toContain('(subpath "/System')
  expect(profile).not.toContain('(subpath "/usr/lib')
  expect(profile).not.toContain('/private/etc/passwd')
  expect(profile).not.toContain('/private/var/run/syslog')
  expect(profile).not.toContain('opendirectory')
  expect(profile).not.toContain('(allow sysctl-read)\n')
  expect(profile).toContain('(sysctl-name "hw.activecpu"')
  expect(profile).not.toContain(os.homedir())
})

test('Seatbelt profile escapes literals and rejects control-line injection', () => {
  const createPolicy = Reflect.get(Harness, 'createMacOsSandboxPolicy')
  const renderProfile = Reflect.get(Harness, 'renderSeatbeltProfile')
  expect(typeof createPolicy).toBe('function')
  expect(typeof renderProfile).toBe('function')
  if (typeof createPolicy !== 'function' || typeof renderProfile !== 'function') return

  const profile = renderProfile(
    createPolicy({
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/child"quoted\\name.bundle',
      codeRoots: ['/private/app'],
      resourceRoots: [],
      executablePaths: [],
      readOnlyRoots: [],
      writeRoots: [],
      scratchRoot: '/private/scratch',
      loopbackPorts: []
    })
  )
  expect(profile).toContain('(literal "/private/app/child\\"quoted\\\\name.bundle")')
  expect(() =>
    createPolicy({
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/child\n(allow default)',
      codeRoots: ['/private/app'],
      resourceRoots: [],
      executablePaths: [],
      readOnlyRoots: [],
      writeRoots: [],
      scratchRoot: '/private/scratch',
      loopbackPorts: []
    })
  ).toThrow(/newline/i)
  expect(() =>
    createPolicy({
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/child\0.bundle',
      codeRoots: ['/private/app'],
      resourceRoots: [],
      executablePaths: [],
      readOnlyRoots: [],
      writeRoots: [],
      scratchRoot: '/private/scratch',
      loopbackPorts: []
    })
  ).toThrow(/NUL/i)
})

test('Seatbelt profile omits all network grants without Weather', () => {
  const createPolicy = Reflect.get(Harness, 'createMacOsSandboxPolicy')
  const renderProfile = Reflect.get(Harness, 'renderSeatbeltProfile')
  expect(typeof createPolicy).toBe('function')
  expect(typeof renderProfile).toBe('function')
  if (typeof createPolicy !== 'function' || typeof renderProfile !== 'function') return

  const profile = renderProfile(
    createPolicy({
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/child.bundle',
      codeRoots: ['/private/app'],
      resourceRoots: [],
      executablePaths: ['/usr/local/bin/obsidian'],
      readOnlyRoots: [],
      writeRoots: ['/private/vault'],
      scratchRoot: '/private/scratch',
      loopbackPorts: []
    })
  )

  expect(profile).not.toContain('network-outbound')
  expect(profile).not.toContain('(remote ip')
  expect(profile).not.toContain('unix-socket')
})

test('Seatbelt profile grants only the configured Obsidian CLI unix socket', () => {
  const createPolicy = Reflect.get(Harness, 'createMacOsSandboxPolicy')
  const renderProfile = Reflect.get(Harness, 'renderSeatbeltProfile')
  expect(typeof createPolicy).toBe('function')
  expect(typeof renderProfile).toBe('function')
  if (typeof createPolicy !== 'function' || typeof renderProfile !== 'function') {
    return
  }

  const socket = '/Users/demo/.obsidian-cli.sock'
  const profile = renderProfile(
    createPolicy({
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/child.bundle',
      codeRoots: ['/private/app'],
      resourceRoots: [],
      executablePaths: [
        '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli'
      ],
      readOnlyRoots: ['/private/vault'],
      writeRoots: [],
      scratchRoot: '/private/scratch',
      loopbackPorts: [],
      unixSocketPaths: [socket]
    })
  )

  expect(profile).toContain(
    `(remote unix-socket (path "${socket}"))`
  )
  expect(profile).toContain(`(literal "${socket}")`)
  expect(profile).not.toContain('(remote ip')
  expect(profile).not.toContain('(remote unix-socket))')
})

test('sandbox artifacts use owner-only modes and clean up completely', async () => {
  const createArtifacts = Reflect.get(Harness, 'createSandboxArtifacts')
  expect(typeof createArtifacts).toBe('function')
  if (typeof createArtifacts !== 'function') return

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qvac-sandbox-profile-test-'))
  const artifacts = await createArtifacts({
    temporaryRoot,
    agentId: 'agent/with unsafe chars',
    generation: 3,
    profile: '(version 1)\n(deny default)\n'
  })

  expect((await stat(artifacts.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(artifacts.scratchRoot)).mode & 0o777).toBe(0o700)
  expect((await stat(artifacts.profilePath)).mode & 0o777).toBe(0o600)

  await artifacts.cleanup()
  await expect(stat(artifacts.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('sandbox artifact cleanup retries after a transient removal failure', async () => {
  const createArtifacts = Reflect.get(Harness, 'createSandboxArtifacts')
  expect(typeof createArtifacts).toBe('function')
  if (typeof createArtifacts !== 'function') return

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qvac-sandbox-retry-test-'))
  const artifacts = await createArtifacts({
    temporaryRoot,
    agentId: 'retry-agent',
    generation: 1,
    profile: '(version 1)\n(deny default)\n'
  })

  await chmod(temporaryRoot, 0o500)
  await expect(artifacts.cleanup()).rejects.toThrow()
  await chmod(temporaryRoot, 0o700)
  await artifacts.cleanup()
  await expect(stat(artifacts.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
