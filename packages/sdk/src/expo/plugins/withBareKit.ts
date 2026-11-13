import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import path from 'path'
import {
  BARE_KIT_RESOURCES,
  IOS_V8_ENTITLEMENT,
  NATIVE_MODULES,
  type IosEngine
} from '@/commands/bundle/link'

const {
  IOSConfig,
  WarningAggregator,
  withAppBuildGradle,
  withEntitlementsPlist,
  withGradleProperties,
  withPlugins,
  withProjectBuildGradle,
  withSettingsGradle,
  withXcodeProject
} = configPlugins

const PLUGIN = '@qvac/sdk/expo-plugin'

const ANDROID_MODULE = path.basename(NATIVE_MODULES.android.dir)
const IOS_PACKAGE = path.basename(NATIVE_MODULES.ios.dir)

const JITPACK = 'https://www.jitpack.io'

/** bare-kit-kotlin is built with Kotlin 2.4, which Expo builds from SDK 58. */
const MIN_KOTLIN_VERSION = '2.4.20'

interface BareKitOptions {
  /** The engine `withMobileBundle` links Bare Kit with on iOS. */
  iosEngine?: IosEngine | undefined
}

/**
 * Expo plugin: adds the Bare Kit module that `withMobileBundle` writes to the
 * app, as a Gradle module on Android and a local Swift package on iOS, and
 * raises the app's Kotlin to the version Bare Kit needs. Fails when
 * expo-bare-kit is also configured, since both write Bare Kit and the native
 * addons into the app.
 */
function withBareKit(config: ExpoConfig, options: BareKitOptions = {}): ExpoConfig {
  if (hasPlugin(config, 'expo-bare-kit')) {
    throw new Error(
      `QVAC: ${PLUGIN} cannot be used with expo-bare-kit, since both add Bare Kit and its native ` +
        'addons to the app. Remove expo-bare-kit from the plugins.'
    )
  }

  config = withPlugins(config, [withAndroidModule, withJitPack, withKotlinVersion, withIosPackage])
  return options.iosEngine === 'v8' ? withV8Entitlement(config) : config
}

/** Bare Kit's V8 reserves more address space than iOS gives an app without this entitlement. */
function withV8Entitlement(config: ExpoConfig): ExpoConfig {
  return withEntitlementsPlist(config, (config) => {
    addV8Entitlement(config.modResults)
    return config
  })
}

export function addV8Entitlement(entitlements: Record<string, unknown>): void {
  entitlements[IOS_V8_ENTITLEMENT] = true
}

function hasPlugin(config: ExpoConfig, name: string): boolean {
  return (config.plugins ?? []).some((plugin) =>
    Array.isArray(plugin) ? plugin[0] === name : plugin === name
  )
}

export function includeModule(settings: string): string {
  const include = `include ':${ANDROID_MODULE}'`
  return settings.includes(include) ? settings : `${settings}\n${include}\n`
}

export function addModuleDependency(appBuildGradle: string): string {
  const dependency = `implementation project(':${ANDROID_MODULE}')`
  if (appBuildGradle.includes(dependency)) return appBuildGradle
  return appBuildGradle.replace(/dependencies\s*{/, (match) => `${match}\n    ${dependency}`)
}

/** bare-kit-kotlin is published on JitPack. */
export function addJitPack(buildGradle: string): string {
  const repository = `maven { url '${JITPACK}' }`
  if (buildGradle.includes(repository)) return buildGradle
  return buildGradle.replace(
    /allprojects\s*{\s*repositories\s*{/,
    (match) => `${match}\n    ${repository}`
  )
}

type GradleProperties = configPlugins.AndroidConfig.Properties.PropertiesItem[]

export function raiseKotlinVersion(properties: GradleProperties): void {
  const key = 'android.kotlinVersion'
  const property = properties.find((item) => item.type === 'property' && item.key === key)
  if (property === undefined) {
    properties.push({ type: 'property', key, value: MIN_KOTLIN_VERSION })
  } else if (
    property.type === 'property' &&
    compareVersions(property.value, MIN_KOTLIN_VERSION) < 0
  ) {
    property.value = MIN_KOTLIN_VERSION
  }
}

/** Compares the numeric parts of two versions; a suffix such as `-RC` is ignored. */
function compareVersions(a: string, b: string): number {
  const numbers = (version: string) => version.split('.').map((part) => parseInt(part, 10) || 0)
  const x = numbers(a)
  const y = numbers(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function withKotlinVersion(config: ExpoConfig): ExpoConfig {
  return withGradleProperties(config, (config) => {
    raiseKotlinVersion(config.modResults)
    return config
  })
}

function withAndroidModule(config: ExpoConfig): ExpoConfig {
  config = withSettingsGradle(config, (config) => {
    config.modResults.contents = includeModule(config.modResults.contents)
    return config
  })

  return withAppBuildGradle(config, (config) => {
    if (!isGroovy(config.modResults.language, 'app build.gradle')) return config
    config.modResults.contents = addModuleDependency(config.modResults.contents)
    warnUnless(
      config.modResults.contents,
      `:${ANDROID_MODULE}`,
      'a dependencies block in app build.gradle'
    )
    return config
  })
}

function withJitPack(config: ExpoConfig): ExpoConfig {
  return withProjectBuildGradle(config, (config) => {
    if (!isGroovy(config.modResults.language, 'build.gradle')) return config
    config.modResults.contents = addJitPack(config.modResults.contents)
    warnUnless(config.modResults.contents, JITPACK, 'allprojects.repositories in build.gradle')
    return config
  })
}

/** Warns when `contents` lacks `expected`, which the plugin adds to `place`. */
function warnUnless(contents: string, expected: string, place: string) {
  if (contents.includes(expected)) return
  WarningAggregator.addWarningAndroid(
    PLUGIN,
    `Cannot find ${place} to add Bare Kit to; add ${expected} there yourself`
  )
}

function isGroovy(language: string, file: string): boolean {
  if (language === 'groovy') return true
  WarningAggregator.addWarningAndroid(PLUGIN, `Cannot add Bare Kit to a non-Groovy ${file}`)
  return false
}

interface PbxEntry {
  value: string
  comment: string
}

interface XcodeObjects {
  PBXNativeTarget: Record<string, { name?: string; packageProductDependencies?: PbxEntry[] }>
  PBXFileReference: Record<string, unknown>
  PBXBuildFile: Record<string, unknown>
  PBXGroup: Record<string, { children: PbxEntry[] }>
  XCLocalSwiftPackageReference?: Record<string, unknown>
  XCSwiftPackageProductDependency?: Record<string, unknown>
}

export interface XcodeProject {
  hash: { project: { objects: XcodeObjects } }
  generateUuid(): string
  getFirstProject(): { firstProject: { mainGroup: string; packageReferences?: PbxEntry[] } }
  pbxFrameworksBuildPhaseObj(target: string): { files: PbxEntry[] } | null
  pbxResourcesBuildPhaseObj(target: string): { files: PbxEntry[] } | null
}

function withIosPackage(config: ExpoConfig): ExpoConfig {
  return withXcodeProject(config, (config) => {
    // The Swift package is written only on macOS, which signs its frameworks.
    if (process.platform !== 'darwin') return config
    const project = config.modResults as unknown as XcodeProject
    const { uuid } = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project: config.modResults,
      projectName: config.modRequest.projectName!
    })
    addSwiftPackage(project, uuid, IOS_PACKAGE)
    addFolderResource(project, uuid, `${IOS_PACKAGE}/${BARE_KIT_RESOURCES}`)
    return config
  })
}

function unquote(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value
}

/** Links the product of the local Swift package at `relativePath`, named the same, into `target`. */
export function addSwiftPackage(project: XcodeProject, target: string, relativePath: string) {
  const objects = project.hash.project.objects
  const nativeTarget = objects.PBXNativeTarget[target]
  if (nativeTarget === undefined) throw new Error(`QVAC: unknown Xcode target '${target}'`)

  const packages = (objects.XCLocalSwiftPackageReference ??= {})
  const products = (objects.XCSwiftPackageProductDependency ??= {})
  const comment = `XCLocalSwiftPackageReference "${relativePath}"`

  let packageId = Object.entries(packages).find(
    ([, value]) =>
      typeof value === 'object' &&
      unquote((value as { relativePath?: unknown }).relativePath) === relativePath
  )?.[0]
  if (packageId === undefined) {
    packageId = project.generateUuid()
    packages[packageId] = {
      isa: 'XCLocalSwiftPackageReference',
      relativePath: `"${relativePath}"`
    }
    packages[`${packageId}_comment`] = comment
    const root = project.getFirstProject().firstProject
    ;(root.packageReferences ??= []).push({ value: packageId, comment })
  }

  const dependencies = (nativeTarget.packageProductDependencies ??= [])
  const linked = dependencies.some(({ value }) => {
    const dependency = products[value] as { package?: string; productName?: string } | undefined
    return dependency?.package === packageId && dependency.productName === relativePath
  })
  if (linked) return

  const dependency = project.generateUuid()
  products[dependency] = {
    isa: 'XCSwiftPackageProductDependency',
    package: packageId,
    package_comment: comment,
    productName: relativePath
  }
  products[`${dependency}_comment`] = relativePath
  dependencies.push({ value: dependency, comment: relativePath })

  const file = project.generateUuid()
  objects.PBXBuildFile[file] = {
    isa: 'PBXBuildFile',
    productRef: dependency,
    productRef_comment: relativePath
  }
  objects.PBXBuildFile[`${file}_comment`] = `${relativePath} in Frameworks`

  const phase = project.pbxFrameworksBuildPhaseObj(target)
  if (phase === null) {
    throw new Error(`QVAC: Xcode target '${nativeTarget.name}' has no Frameworks phase`)
  }
  phase.files.push({ value: file, comment: `${relativePath} in Frameworks` })
}

/** Copies the folder at `relativePath` into the app bundle as is. */
export function addFolderResource(project: XcodeProject, target: string, relativePath: string) {
  const objects = project.hash.project.objects
  const exists = Object.values(objects.PBXFileReference).some(
    (value) =>
      typeof value === 'object' && unquote((value as { path?: unknown }).path) === relativePath
  )
  if (exists) return

  const name = path.posix.basename(relativePath)
  const file = project.generateUuid()
  objects.PBXFileReference[file] = {
    isa: 'PBXFileReference',
    lastKnownFileType: 'folder',
    name: `"${name}"`,
    path: `"${relativePath}"`,
    sourceTree: '"<group>"'
  }
  objects.PBXFileReference[`${file}_comment`] = name
  objects.PBXGroup[project.getFirstProject().firstProject.mainGroup]!.children.push({
    value: file,
    comment: name
  })

  const build = project.generateUuid()
  objects.PBXBuildFile[build] = { isa: 'PBXBuildFile', fileRef: file, fileRef_comment: name }
  objects.PBXBuildFile[`${build}_comment`] = `${name} in Resources`

  const phase = project.pbxResourcesBuildPhaseObj(target)
  if (phase === null) throw new Error(`QVAC: Xcode target '${target}' has no Resources phase`)
  phase.files.push({ value: build, comment: `${name} in Resources` })
}

export default withBareKit
