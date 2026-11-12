import test from 'brittle'
import configPlugins from '@expo/config-plugins'
import withBareKit, {
  addExtendedVirtualAddressing,
  addFolderResource,
  addJitPack,
  addModuleDependency,
  addSwiftPackage,
  includeModule,
  raiseKotlinVersion,
  type XcodeProject
} from '@/expo/plugins/withBareKit'

type GradleProperties = configPlugins.AndroidConfig.Properties.PropertiesItem[]

const APP_BUILD_GRADLE = `android {\n}\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n`
const PROJECT_BUILD_GRADLE = `allprojects {\n  repositories {\n    google()\n  }\n}\n`

test('includeModule: includes the Bare Kit module once', (t) => {
  const settings = includeModule("rootProject.name = 'app'\n")
  t.ok(settings.includes("include ':qvac-bare-kit'"))
  t.is(includeModule(settings), settings)
})

test('addModuleDependency: makes the app depend on the module once', (t) => {
  const gradle = addModuleDependency(APP_BUILD_GRADLE)
  t.ok(gradle.includes("dependencies {\n    implementation project(':qvac-bare-kit')"))
  t.is(addModuleDependency(gradle), gradle)
})

test('addJitPack: adds the JitPack repository once', (t) => {
  const gradle = addJitPack(PROJECT_BUILD_GRADLE)
  t.ok(gradle.includes("maven { url 'https://www.jitpack.io' }"))
  t.is(addJitPack(gradle), gradle)
})

test('raiseKotlinVersion: sets, raises and keeps a newer Kotlin version', (t) => {
  const missing: GradleProperties = []
  raiseKotlinVersion(missing)
  t.alike(missing, [{ type: 'property', key: 'android.kotlinVersion', value: '2.4.20' }])

  const older: GradleProperties = [
    { type: 'property', key: 'android.kotlinVersion', value: '2.1.20' }
  ]
  raiseKotlinVersion(older)
  t.alike(older, [{ type: 'property', key: 'android.kotlinVersion', value: '2.4.20' }])

  const newer: GradleProperties = [
    { type: 'property', key: 'android.kotlinVersion', value: '2.5.0' }
  ]
  raiseKotlinVersion(newer)
  t.alike(newer, [{ type: 'property', key: 'android.kotlinVersion', value: '2.5.0' }])
})

function fakeXcodeProject() {
  let next = 0
  const frameworks = { files: [] as { value: string; comment: string }[] }
  const resources = { files: [] as { value: string; comment: string }[] }
  const root: { mainGroup: string; packageReferences?: { value: string; comment: string }[] } = {
    mainGroup: 'MAIN'
  }
  const project = {
    hash: {
      project: {
        objects: {
          PBXNativeTarget: { APP: { name: 'App' } },
          PBXFileReference: {},
          PBXBuildFile: {},
          PBXGroup: { MAIN: { children: [] } }
        }
      }
    },
    generateUuid: () => `ID${next++}`,
    getFirstProject: () => ({ firstProject: root }),
    pbxFrameworksBuildPhaseObj: () => frameworks,
    pbxResourcesBuildPhaseObj: () => resources
  } as XcodeProject
  return { project, root, frameworks, resources }
}

test('addSwiftPackage: links the local package into the app once', (t) => {
  const { project, root, frameworks } = fakeXcodeProject()

  addSwiftPackage(project, 'APP', 'QvacBareKit')
  addSwiftPackage(project, 'APP', 'QvacBareKit')

  t.is(root.packageReferences?.length, 1)
  t.is(project.hash.project.objects.PBXNativeTarget['APP']!.packageProductDependencies?.length, 1)
  t.alike(
    frameworks.files.map((file) => file.comment),
    ['QvacBareKit in Frameworks']
  )
})

test('addFolderResource: copies the assets folder into the app once', (t) => {
  const { project, resources } = fakeXcodeProject()

  addFolderResource(project, 'APP', 'QvacBareKit/bare-stow')
  addFolderResource(project, 'APP', 'QvacBareKit/bare-stow')

  t.alike(
    resources.files.map((file) => file.comment),
    ['bare-stow in Resources']
  )
  t.is(project.hash.project.objects.PBXGroup['MAIN']!.children.length, 1)
})

test('addExtendedVirtualAddressing: adds the entitlement and keeps the others', (t) => {
  const entitlements = addExtendedVirtualAddressing({ 'aps-environment': 'development' })
  t.alike(entitlements, {
    'aps-environment': 'development',
    'com.apple.developer.kernel.extended-virtual-addressing': true
  })
})

test('withBareKit: registers an iOS entitlements mod', (t) => {
  const config = withBareKit({ name: 'app', slug: 'app', _internal: { projectRoot: '.' } }) as {
    mods?: { ios?: { entitlements?: unknown } }
  }
  t.is(typeof config.mods?.ios?.entitlements, 'function')
})

test('withBareKit: refuses an app that also uses expo-bare-kit', (t) => {
  t.exception(
    () => withBareKit({ name: 'app', slug: 'app', plugins: [['expo-bare-kit', {}]] }),
    /cannot be used with expo-bare-kit/
  )
})
