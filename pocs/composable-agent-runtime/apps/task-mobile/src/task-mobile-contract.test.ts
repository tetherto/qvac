import { describe, expect, test } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dir, '..')
const appEntryPoints = ['App.tsx', 'index.ts']
const forbiddenSourceTokens = [
  '../generated/',
  './generated/',
  '/generated/',
  'runner-broker',
  'worklets/',
  'build-worklets',
  'link-android-addons',
  'link-ios-addons',
  'android-runtime-bridge',
  'ipc-duplex',
  ':qvac_sdk',
  'IsolationProbe'
]
const forbiddenPackageDeps = [
  'bare-pack',
  'bare-bundle',
  'bare-bundle-id',
  'bare-module-lexer',
  'bare-module-traverse',
  'bare-type-stripper'
]
const removedIsolationPaths = [
  'android/app/src/main/java/com/qvac/poc/composableruntime/BareRuntimeService.kt',
  'android/app/src/main/java/com/qvac/poc/composableruntime/QvacRuntimeBridgeModule.kt',
  'android/app/src/main/java/com/qvac/poc/composableruntime/QvacRuntimeBridgePackage.kt',
  'android/app/src/main/aidl/com/qvac/poc/composableruntime/IRuntimeService.aidl',
  'ios/IsolationProbeExtension/IsolationProbeExtension.swift',
  'ios/IsolationProbeShared.swift',
  'ios/ComposableRuntimeFeasibility/IsolationProbeHost.swift',
  'scripts/configure-isolation-probe.rb'
]

describe('task-mobile clean consumer contract', () => {
  test('app config registers only the assistant Expo plugin', async () => {
    const appConfig = JSON.parse(
      await readFile(path.join(appRoot, 'app.json'), 'utf8')
    ) as { expo?: { plugins?: unknown[] } }
    expect(appConfig.expo?.plugins).toEqual(['@qvac/assistant/expo-plugin'])
  })

  test('package scripts stay Expo-only and required peers are explicit', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(appRoot, 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const scripts = packageJson.scripts ?? {}
    const dependencies = packageJson.dependencies ?? {}
    const devDependencies = packageJson.devDependencies ?? {}
    expect(scripts.start).toBe('expo start --dev-client')
    expect(scripts.ios).toBe('expo run:ios --device')
    expect(scripts['android:prebuild']).toBe(
      'expo prebuild --clean --platform android --no-install'
    )
    expect(scripts.preandroid).toBe('bun run android:prebuild')
    expect(scripts.android).toBe('expo run:android --device')
    expect(scripts['preandroid:build']).toBe('bun run android:prebuild')
    expect(scripts['android:build']).toBe(
      './android/gradlew -p android app:assembleDebug'
    )
    expect(scripts['preandroid:release']).toBe('bun run android:prebuild')
    expect(scripts['android:release']).toBe(
      './android/gradlew -p android app:assembleRelease'
    )
    expect(scripts['preandroid:release:device']).toBe(
      'bun run android:prebuild'
    )
    expect(scripts['android:release:device']).toBe(
      'expo run:android --variant release --device'
    )
    expect(dependencies['expo-build-properties']).toBe('~1.0.10')
    expect(dependencies['bare-link']).toBeDefined()
    for (const command of Object.values(scripts)) {
      expect(command.includes('build-worklets')).toBeFalse()
      expect(command.includes('link-android-addons')).toBeFalse()
      expect(command.includes('link-ios-addons')).toBeFalse()
      expect(command.includes('scripts/run-android.ts')).toBeFalse()
      expect(command.includes('scripts/start.ts')).toBeFalse()
    }
    for (const name of forbiddenPackageDeps) {
      expect(dependencies[name]).toBeUndefined()
      expect(devDependencies[name]).toBeUndefined()
    }
  })

  test('PoC verification includes final artifact validation', async () => {
    const rootPackage = JSON.parse(
      await readFile(path.join(appRoot, '..', '..', 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    const verifySource = await readFile(
      path.join(appRoot, '..', '..', 'scripts', 'verify.ts'),
      'utf8'
    )
    expect(rootPackage.scripts?.['validate:artifacts']).toBe(
      'bun run scripts/validate-artifacts.ts'
    )
    expect(rootPackage.scripts?.['android:prebuild']).toBe(
      'bun run --cwd apps/task-mobile android:prebuild'
    )
    expect(rootPackage.scripts?.android).toBe(
      'bun run --cwd apps/task-mobile android'
    )
    expect(rootPackage.scripts?.['android:build']).toBe(
      'bun run --cwd apps/task-mobile android:build'
    )
    expect(rootPackage.scripts?.['android:release']).toBe(
      'bun run --cwd apps/task-mobile android:release'
    )
    expect(rootPackage.scripts?.['android:release:device']).toBe(
      'bun run --cwd apps/task-mobile android:release:device'
    )
    expect(verifySource.includes("'test:artifacts'")).toBeTrue()
  })

  test('recursive app source graph avoids app-local harness and isolation plumbing', async () => {
    const visited = new Set<string>()
    const queue = [...appEntryPoints]
    while (queue.length > 0) {
      const relativePath = queue.shift()
      if (!relativePath || visited.has(relativePath)) continue
      visited.add(relativePath)
      const absolutePath = path.join(appRoot, relativePath)
      const source = await readFile(absolutePath, 'utf8')
      for (const token of forbiddenSourceTokens) {
        expect(source.includes(token)).toBeFalse()
      }
      for (const specifier of parseImports(source)) {
        if (!specifier.startsWith('.')) continue
        const next = await resolveImportPath(relativePath, specifier)
        queue.push(next)
      }
    }
    expect(visited.size).toBeGreaterThan(0)
  })

  test('metro config does not add custom .bundle asset rule', async () => {
    const source = await readFile(path.join(appRoot, 'metro.config.cjs'), 'utf8')
    expect(source.includes("assetExts.push('bundle')")).toBeFalse()
    expect(source.includes('assetExts.push("bundle")')).toBeFalse()
  })

  test('process-isolation scaffolding has been removed', async () => {
    for (const relativePath of removedIsolationPaths) {
      const exists = await pathExists(path.join(appRoot, relativePath))
      expect(exists).toBeFalse()
    }
  })

  test('task UI exposes cancellation action', async () => {
    const source = await readFile(path.join(appRoot, 'src/task-screen.tsx'), 'utf8')
    expect(source.includes('Cancel task')).toBeTrue()
    expect(source.includes('onCancelTask')).toBeTrue()
  })
})

function parseImports(source: string) {
  const values = new Set<string>()
  for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
    const value = match[1]
    if (value) values.add(value)
  }
  for (const match of source.matchAll(/import\(['"]([^'"]+)['"]\)/g)) {
    const value = match[1]
    if (value) values.add(value)
  }
  return [...values]
}

async function resolveImportPath(from: string, specifier: string) {
  const base = path.resolve(path.dirname(path.join(appRoot, from)), specifier)
  const candidates = [
    path.relative(appRoot, base),
    path.relative(appRoot, `${base}.ts`),
    path.relative(appRoot, `${base}.tsx`),
    path.relative(appRoot, path.join(base, 'index.ts')),
    path.relative(appRoot, path.join(base, 'index.tsx'))
  ]
  for (const candidate of candidates) {
    if (await pathExists(path.join(appRoot, candidate))) return candidate
  }
  throw new Error(`Could not resolve local import ${specifier} from ${from}`)
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}
