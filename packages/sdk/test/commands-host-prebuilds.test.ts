import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NativeAddon } from '@/commands/verify/addon-source'
import { ensureHostPrebuilds, findMissingHostPrebuilds } from '@/commands/host-prebuilds/index'
import {
  detectPackageManager,
  installArgs,
  parsePnpmWorkspacePackages
} from '@/commands/host-prebuilds/package-manager'
import {
  HostPrebuildsInstallFailedError,
  HostPrebuildsInstallRefusedError
} from '@/utils/errors-client'
import { IOS_HOSTS, installFakePackageManager, withPath } from './fixtures/fake-package-manager'

const MOBILE_HOSTS = ['android-arm64', ...IOS_HOSTS]

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-host-prebuilds-')))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function hostAddonMap(name: string) {
  return {
    linux: { x64: [`${name}-linux-x64`, './addon-unavailable.js'] },
    darwin: { arm64: [`${name}-darwin-arm64`, './addon-unavailable.js'] },
    android: { arm64: [`${name}-android-arm64`, './addon-unavailable.js'] },
    ios: [`${name}-ios`, './addon-unavailable.js'],
    default: './addon-unavailable.js'
  }
}

function writeSplitAddon(
  root: string,
  name: string,
  version: string,
  relDir?: string
): NativeAddon {
  const packageRoot = path.join(root, relDir ?? path.join('node_modules', ...name.split('/')))
  writeJson(path.join(packageRoot, 'package.json'), {
    name,
    version,
    addon: true,
    imports: { '#host-addon': hostAddonMap(name) }
  })
  return { name, version, packageRoot, packageJsonPath: path.join(packageRoot, 'package.json') }
}

function writeFatAddon(root: string, name: string, version: string, hosts: string[]): NativeAddon {
  const packageRoot = path.join(root, 'node_modules', ...name.split('/'))
  writeJson(path.join(packageRoot, 'package.json'), { name, version, addon: true })
  for (const host of hosts) writeBare(path.join(packageRoot, 'prebuilds', host))
  return { name, version, packageRoot, packageJsonPath: path.join(packageRoot, 'package.json') }
}

function writePlatformPackage(
  root: string,
  name: string,
  addon: string,
  version: string,
  hosts: string[]
) {
  const platformRoot = path.join(root, 'node_modules', ...name.split('/'))
  writeJson(path.join(platformRoot, 'package.json'), { name, version })
  writeJson(path.join(platformRoot, 'addon', 'package.json'), { name: addon, version, addon: true })
  for (const host of hosts) writeBare(path.join(platformRoot, 'addon', 'prebuilds', host))
}

function writeBare(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'addon.bare'), '')
}

describe('detectPackageManager', () => {
  for (const [lockfile, manager] of [
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn']
  ] as const) {
    it(`reads ${manager} from ${lockfile}`, async () => {
      await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, lockfile), '')
        const detected = await detectPackageManager(dir)
        assert.equal(detected.manager, manager)
      })
    })
  }

  it('prefers the packageManager field over a lockfile in the same directory', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { packageManager: 'pnpm@9.12.0+sha512.abc' })
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      assert.equal((await detectPackageManager(dir)).manager, 'pnpm')
    })
  })

  it('walks up from a workspace member to the workspace root', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { workspaces: ['apps/*'] })
      fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
      const member = path.join(dir, 'apps', 'mobile')
      writeJson(path.join(member, 'package.json'), { name: 'mobile' })
      const detected = await detectPackageManager(member)
      assert.equal(detected.manager, 'yarn')
      assert.ok(detected.manager !== null && detected.source === path.join(dir, 'yarn.lock'))
    })
  })

  it('reads a pnpm workspace root from pnpm-workspace.yaml', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(
        path.join(dir, 'pnpm-workspace.yaml'),
        'packages:\n  - \'apps/**\'\n  - "!apps/legacy"\nonlyBuiltDependencies: []\n'
      )
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
      const member = path.join(dir, 'apps', 'mobile', 'client')
      writeJson(path.join(member, 'package.json'), { name: 'client' })
      assert.equal((await detectPackageManager(member)).manager, 'pnpm')

      const excluded = path.join(dir, 'apps', 'legacy')
      writeJson(path.join(excluded, 'package.json'), { name: 'legacy' })
      assert.equal(
        (await detectPackageManager(excluded)).manager,
        null,
        'a negated pattern removes the member'
      )
    })
  })

  it('reads the object form of the workspaces field', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), {
        packageManager: 'bun@1.3.0',
        workspaces: { packages: ['packages/*'] }
      })
      const member = path.join(dir, 'packages', 'app')
      writeJson(path.join(member, 'package.json'), { name: 'app' })
      assert.equal((await detectPackageManager(member)).manager, 'bun')
    })
  })

  it('does not borrow the package manager of an enclosing project that is not its workspace', async () => {
    await withTempDir(async (dir) => {
      // The SDK e2e layout: a bun-installed package with an npm-installed
      // consumer app nested under it.
      writeJson(path.join(dir, 'package.json'), { name: 'sdk' })
      fs.writeFileSync(path.join(dir, 'bun.lock'), '')
      const app = path.join(dir, 'e2e', 'build', 'consumers', 'android')
      writeJson(path.join(app, 'package.json'), { name: 'consumer' })

      const detected = await detectPackageManager(app)
      assert.equal(detected.manager, null)
      assert.ok(
        detected.manager === null && /not a workspace root that lists it/.test(detected.reason)
      )
    })
  })

  it('reads the install files npm leaves in node_modules when there is no lockfile', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'bun.lock'), '')
      const app = path.join(dir, 'e2e', 'build', 'consumers', 'android')
      writeJson(path.join(app, 'package.json'), { name: 'consumer' })
      writeJson(path.join(app, 'node_modules', '.package-lock.json'), { lockfileVersion: 3 })
      assert.equal((await detectPackageManager(app)).manager, 'npm')
    })
  })

  for (const [marker, manager] of [
    ['.package-lock.json', 'npm'],
    ['.modules.yaml', 'pnpm'],
    ['.yarn-state.yml', 'yarn'],
    ['.yarn-integrity', 'yarn']
  ] as const) {
    it(`reads ${manager} from node_modules/${marker}`, async () => {
      await withTempDir(async (dir) => {
        fs.mkdirSync(path.join(dir, 'node_modules'))
        fs.writeFileSync(path.join(dir, 'node_modules', marker), '')
        assert.equal((await detectPackageManager(dir)).manager, manager)
      })
    })
  }

  it('uses the nearest lockfile, not one further up', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      const app = path.join(dir, 'app')
      fs.mkdirSync(app)
      fs.writeFileSync(path.join(app, 'bun.lock'), '')
      assert.equal((await detectPackageManager(app)).manager, 'bun')
    })
  })

  it('refuses to guess between lockfiles of different package managers', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
      const detected = await detectPackageManager(dir)
      assert.equal(detected.manager, null)
      assert.ok(detected.manager === null && /npm, pnpm/.test(detected.reason))
    })
  })

  it('refuses when the lockfile and the installed tree disagree', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'bun.lock'), '')
      fs.mkdirSync(path.join(dir, 'node_modules'))
      fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '')
      const detected = await detectPackageManager(dir)
      assert.equal(detected.manager, null)
      assert.ok(
        detected.manager === null &&
          detected.reason.includes(path.join('node_modules', '.package-lock.json'))
      )
    })
  })

  it('treats package-lock.json and npm-shrinkwrap.json as one package manager', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), '')
      assert.equal((await detectPackageManager(dir)).manager, 'npm')
    })
  })

  it('rejects a packageManager field naming an unsupported tool', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { packageManager: 'cnpm@9.0.0' })
      const detected = await detectPackageManager(dir)
      assert.equal(detected.manager, null)
      assert.ok(detected.manager === null && /cnpm@9\.0\.0/.test(detected.reason))
    })
  })
})

describe('parsePnpmWorkspacePackages', () => {
  it('reads block and flow sequences and ignores other keys', () => {
    assert.deepEqual(
      parsePnpmWorkspacePackages(
        "# workspace\npackages:\n  - apps/*   # apps\n  - 'packages/**'\n\ncatalog:\n  react: 19.1.0\n"
      ),
      ['apps/*', 'packages/**']
    )
    assert.deepEqual(parsePnpmWorkspacePackages('packages: [\'apps/*\', "!apps/old"]\n'), [
      'apps/*',
      '!apps/old'
    ])
    assert.deepEqual(parsePnpmWorkspacePackages('onlyBuiltDependencies:\n  - esbuild\n'), [])
  })
})

describe('installArgs', () => {
  it('adds exact-version dependencies with each package manager', () => {
    const specs = ['@qvac/tts-ggml-android-arm64@0.9.2']
    assert.deepEqual(installArgs('npm', specs), ['install', '--save-exact', ...specs])
    assert.deepEqual(installArgs('pnpm', specs), ['add', '--save-exact', ...specs])
    assert.deepEqual(installArgs('bun', specs), ['add', '--exact', ...specs])
    assert.deepEqual(installArgs('yarn', specs), ['add', '--exact', ...specs])
  })
})

describe('findMissingHostPrebuilds', () => {
  it('names the android platform package at the addon version', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      assert.deepEqual(await findMissingHostPrebuilds([addon], ['android-arm64']), [
        {
          name: '@qvac/tts-ggml-android-arm64',
          version: '0.9.2',
          addon: '@qvac/tts-ggml',
          hosts: ['android-arm64']
        }
      ])
    })
  })

  it('needs one grouped -ios package for every iOS host', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/asr-ggml', '0.5.3')
      const missing = await findMissingHostPrebuilds([addon], MOBILE_HOSTS)
      assert.deepEqual(
        missing.map((pkg) => [pkg.name, pkg.hosts]),
        [
          ['@qvac/asr-ggml-android-arm64', ['android-arm64']],
          ['@qvac/asr-ggml-ios', IOS_HOSTS]
        ]
      )
    })
  })

  it('leaves desktop hosts to the addon optionalDependencies', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      assert.deepEqual(await findMissingHostPrebuilds([addon], ['darwin-arm64', 'linux-x64']), [])
    })
  })

  it('skips a platform package installed at the addon version', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      writePlatformPackage(dir, '@qvac/tts-ggml-android-arm64', '@qvac/tts-ggml', '0.9.2', [
        'android-arm64'
      ])
      assert.deepEqual(await findMissingHostPrebuilds([addon], ['android-arm64']), [])
    })
  })

  it('replaces a platform package installed at another version', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      writePlatformPackage(dir, '@qvac/tts-ggml-android-arm64', '@qvac/tts-ggml', '0.9.1', [
        'android-arm64'
      ])
      const missing = await findMissingHostPrebuilds([addon], ['android-arm64'])
      assert.deepEqual(
        missing.map((pkg) => `${pkg.name}@${pkg.version}`),
        ['@qvac/tts-ggml-android-arm64@0.9.2']
      )
    })
  })

  it('skips a source-built addon with a local prebuilds/<host>', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      writeBare(path.join(addon.packageRoot, 'prebuilds', 'android-arm64'))
      assert.deepEqual(await findMissingHostPrebuilds([addon], ['android-arm64']), [])
    })
  })

  it('never names a package for an addon without a #host-addon map', async () => {
    await withTempDir(async (dir) => {
      const addon = writeFatAddon(dir, '@qvac/llm-llamacpp', '0.53.2', [])
      assert.deepEqual(await findMissingHostPrebuilds([addon], MOBILE_HOSTS), [])
    })
  })

  it('skips hosts the bundle does not link the addon on', async () => {
    await withTempDir(async (dir) => {
      const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      addon.linkedHosts = ['android-arm64']
      const missing = await findMissingHostPrebuilds([addon], MOBILE_HOSTS)
      assert.deepEqual(
        missing.map((pkg) => pkg.name),
        ['@qvac/tts-ggml-android-arm64']
      )
    })
  })

  it('refuses when two installed versions of an addon need one platform package', async () => {
    await withTempDir(async (dir) => {
      const top = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const nested = writeSplitAddon(
        dir,
        '@qvac/tts-ggml',
        '0.9.1',
        'node_modules/@qvac/sdk/node_modules/@qvac/tts-ggml'
      )
      await assert.rejects(
        findMissingHostPrebuilds([top, nested], ['android-arm64']),
        (error: unknown) =>
          error instanceof HostPrebuildsInstallRefusedError &&
          /installed at both 0\.9\.2 and 0\.9\.1/.test(error.message)
      )
    })
  })

  it('refuses a platform package name that is not a valid npm name', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = path.join(dir, 'node_modules', 'evil')
      writeJson(path.join(packageRoot, 'package.json'), {
        name: 'evil',
        version: '1.0.0',
        addon: true,
        imports: { '#host-addon': { android: { arm64: 'evil-$(touch pwned)' } } }
      })
      const addon: NativeAddon = {
        name: 'evil',
        version: '1.0.0',
        packageRoot,
        packageJsonPath: path.join(packageRoot, 'package.json')
      }
      await assert.rejects(
        findMissingHostPrebuilds([addon], ['android-arm64']),
        HostPrebuildsInstallRefusedError
      )
    })
  })
})

const posixOnly = { skip: process.platform === 'win32' }

describe('ensureHostPrebuilds', () => {
  it('does nothing when every prebuild resolves, without looking for a package manager', async () => {
    await withTempDir(async (dir) => {
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      writePlatformPackage(dir, '@qvac/tts-ggml-android-arm64', '@qvac/tts-ggml', '0.9.2', [
        'android-arm64'
      ])
      const result = await ensureHostPrebuilds({
        projectRoot: dir,
        hosts: ['android-arm64', 'darwin-arm64'],
        quiet: true
      })
      assert.deepEqual(result, { installed: [], packageManager: null })
    })
  })

  it('refuses without a lockfile and names the exact pins to add', async () => {
    await withTempDir(async (dir) => {
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      await assert.rejects(
        ensureHostPrebuilds({ projectRoot: dir, hosts: MOBILE_HOSTS, quiet: true }),
        (error: unknown) =>
          error instanceof HostPrebuildsInstallRefusedError &&
          error.message.includes('"@qvac/tts-ggml-android-arm64": "0.9.2"') &&
          error.message.includes('"@qvac/tts-ggml-ios": "0.9.2"') &&
          error.dependencies['@qvac/tts-ggml-ios'] === '0.9.2'
      )
    })
  })

  it('installs the missing packages with the detected package manager', posixOnly, async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      writeSplitAddon(dir, '@qvac/asr-ggml', '0.5.3')
      writeFatAddon(dir, '@qvac/llm-llamacpp', '0.53.2', ['android-arm64'])
      const pm = installFakePackageManager(dir, 'pnpm')

      const result = await withPath(pm.binDir, () =>
        ensureHostPrebuilds({
          projectRoot: dir,
          hosts: ['android-arm64'],
          addons: ['@qvac/tts-ggml', '@qvac/llm-llamacpp'],
          quiet: true
        })
      )

      assert.equal(result.packageManager, 'pnpm')
      assert.deepEqual(
        result.installed.map((pkg) => `${pkg.name}@${pkg.version}`),
        ['@qvac/tts-ggml-android-arm64@0.9.2'],
        'only the requested split addon needs a package'
      )
      assert.deepEqual(pm.calls(), [
        { cwd: dir, args: ['add', '--save-exact', '@qvac/tts-ggml-android-arm64@0.9.2'] }
      ])
    })
  })

  it('runs the install in the workspace member, not the workspace root', posixOnly, async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), {
        packageManager: 'bun@1.3.0',
        workspaces: ['apps/*']
      })
      const member = path.join(dir, 'apps', 'mobile')
      writeJson(path.join(member, 'package.json'), { name: 'mobile' })
      writeSplitAddon(member, '@qvac/audiogen-ggml', '0.4.1')
      const pm = installFakePackageManager(dir, 'bun')

      await withPath(pm.binDir, () =>
        ensureHostPrebuilds({ projectRoot: member, hosts: IOS_HOSTS, quiet: true })
      )

      assert.deepEqual(pm.calls(), [
        { cwd: member, args: ['add', '--exact', '@qvac/audiogen-ggml-ios@0.4.1'] }
      ])
    })
  })

  it('reports the failed command and keeps the pins in the error', posixOnly, async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const pm = installFakePackageManager(dir, 'npm', { version: '10.9.0', exitCode: 3 })

      await assert.rejects(
        withPath(pm.binDir, () =>
          ensureHostPrebuilds({ projectRoot: dir, hosts: ['android-arm64'], quiet: true })
        ),
        (error: unknown) =>
          error instanceof HostPrebuildsInstallFailedError &&
          error.message.includes(
            '`npm install --save-exact @qvac/tts-ggml-android-arm64@0.9.2` exited with code 3'
          ) &&
          error.message.includes('fake install failure') &&
          error.dependencies['@qvac/tts-ggml-android-arm64'] === '0.9.2'
      )
    })
  })

  it(
    'fails when the install succeeds but the package still does not resolve',
    posixOnly,
    async () => {
      await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
        writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
        const pm = installFakePackageManager(dir, 'yarn', {
          version: '4.5.0',
          installNothing: true
        })

        await assert.rejects(
          withPath(pm.binDir, () =>
            ensureHostPrebuilds({ projectRoot: dir, hosts: ['android-arm64'], quiet: true })
          ),
          (error: unknown) =>
            error instanceof HostPrebuildsInstallFailedError &&
            /still not installed under node_modules/.test(error.message) &&
            /nodeLinker: node-modules/.test(error.message)
        )
      })
    }
  )

  it('refuses npm older than 7', posixOnly, async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const pm = installFakePackageManager(dir, 'npm', { version: '6.14.18' })

      await assert.rejects(
        withPath(pm.binDir, () =>
          ensureHostPrebuilds({ projectRoot: dir, hosts: ['android-arm64'], quiet: true })
        ),
        (error: unknown) =>
          error instanceof HostPrebuildsInstallRefusedError && /npm 7 or later/.test(error.message)
      )
      assert.deepEqual(pm.calls(), [], 'never installs with an unsupported npm')
    })
  })

  it('refuses Yarn Classic', posixOnly, async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const pm = installFakePackageManager(dir, 'yarn', { version: '1.22.22' })

      await assert.rejects(
        withPath(pm.binDir, () =>
          ensureHostPrebuilds({ projectRoot: dir, hosts: ['android-arm64'], quiet: true })
        ),
        (error: unknown) =>
          error instanceof HostPrebuildsInstallRefusedError && /Yarn Classic/.test(error.message)
      )
      assert.deepEqual(pm.calls(), [])
    })
  })

  it('uses an explicit packageManager instead of detecting one', posixOnly, async () => {
    await withTempDir(async (dir) => {
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const pm = installFakePackageManager(dir, 'npm', { version: '10.9.0' })

      const result = await withPath(pm.binDir, () =>
        ensureHostPrebuilds({
          projectRoot: dir,
          hosts: ['android-arm64'],
          packageManager: 'npm',
          quiet: true
        })
      )

      assert.equal(result.packageManager, 'npm')
      assert.equal(pm.calls().length, 1)
    })
  })

  it('skips requested names that are not installed addons', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'node_modules', 'left-pad', 'package.json'), {
        name: 'left-pad',
        version: '1.3.0'
      })
      const result = await ensureHostPrebuilds({
        projectRoot: dir,
        hosts: ['android-arm64'],
        addons: ['left-pad', '@qvac/not-installed'],
        quiet: true
      })
      assert.deepEqual(result, { installed: [], packageManager: null })
    })
  })

  it('finds addons hoisted to the root of an npm workspace', posixOnly, async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { workspaces: ['apps/*'] })
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
      writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2')
      const member = path.join(dir, 'apps', 'mobile')
      writeJson(path.join(member, 'package.json'), { name: 'mobile' })
      const pm = installFakePackageManager(dir, 'npm', { version: '10.9.0', installRoot: dir })

      const result = await withPath(pm.binDir, () =>
        ensureHostPrebuilds({ projectRoot: member, hosts: ['android-arm64'], quiet: true })
      )

      assert.equal(result.packageManager, 'npm')
      assert.deepEqual(pm.calls(), [
        { cwd: member, args: ['install', '--save-exact', '@qvac/tts-ggml-android-arm64@0.9.2'] }
      ])
    })
  })

  for (const [manager, lockfile, store] of [
    ['pnpm', 'pnpm-lock.yaml', '.pnpm'],
    ['bun', 'bun.lock', '.bun']
  ] as const) {
    it(`finds an addon that only ${manager}'s ${store} store holds`, posixOnly, async () => {
      await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, lockfile), '')
        // Neither the project nor its top-level node_modules names the addon:
        // it is a dependency of the SDK, reachable only through the store's
        // hoisted view.
        const storeRoot = `node_modules/${store}/@qvac+tts-ggml@0.9.2/node_modules/@qvac/tts-ggml`
        const addon = writeSplitAddon(dir, '@qvac/tts-ggml', '0.9.2', storeRoot)
        const hoisted = path.join(dir, 'node_modules', store, 'node_modules', '@qvac', 'tts-ggml')
        fs.mkdirSync(path.dirname(hoisted), { recursive: true })
        fs.symlinkSync(addon.packageRoot, hoisted, 'dir')
        const pm = installFakePackageManager(dir, manager)

        for (const addons of [['@qvac/tts-ggml'], undefined]) {
          const result = await withPath(pm.binDir, () =>
            ensureHostPrebuilds({ projectRoot: dir, hosts: ['android-arm64'], addons, quiet: true })
          )
          if (addons !== undefined) {
            assert.deepEqual(
              result.installed.map((pkg) => pkg.name),
              ['@qvac/tts-ggml-android-arm64']
            )
          } else {
            assert.deepEqual(result.installed, [], 'already installed by the first run')
          }
        }
        assert.equal(pm.calls().length, 1)
      })
    })
  }
})
