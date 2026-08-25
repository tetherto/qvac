import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import type { QvacTestConfig } from '../../types/config.js'

function detectTeamIdFromKeychain(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const subject = execSync(
      'security find-certificate -a -c "Apple Development" -p | openssl x509 -subject -noout',
      {
        encoding: 'utf-8',
        timeout: 10000
      }
    )
    const match = subject.match(/OU=([A-Z0-9]{10,})/)
    return match?.[1]
  } catch {}
  try {
    const subject = execSync(
      'security find-certificate -a -c "iPhone Developer" -p | openssl x509 -subject -noout',
      {
        encoding: 'utf-8',
        timeout: 10000
      }
    )
    const match = subject.match(/OU=([A-Z0-9]{10,})/)
    return match?.[1]
  } catch {}
  return undefined
}

export interface MobileBuildOptions {
  platform: 'ios' | 'android'
  config: string
  runId?: string
  mqttBroker?: string
  /** Stop after prebuild (copy templates, generate config, npm install, expo prebuild). Skip native build. */
  prepareOnly?: boolean
}

function resolveConfigValue(value: unknown): unknown {
  if (!value) return undefined
  if (typeof value === 'object' && value !== null && 'env' in value) {
    const envVar = (value as { env: string }).env
    return process.env[envVar]
  }
  return value
}

function generateMobileConfigFile(
  config: QvacTestConfig,
  runId: string,
  outputDir: string,
  configDir: string
): string | undefined {
  const mqttConfig: any = config.mqtt || {}

  // Resolve broker config
  const broker = mqttConfig.broker || {}
  const protocol = resolveConfigValue(broker.protocol) || 'ws'
  const host = resolveConfigValue(broker.host) || 'localhost'
  const port = resolveConfigValue(broker.port) || '8080'
  const mqttPath = resolveConfigValue(broker.path) || '/mqtt'

  // Resolve auth config
  const username = resolveConfigValue(mqttConfig.username)
  const password = resolveConfigValue(mqttConfig.password)

  // Resolve TLS config
  const rejectUnauthorized = mqttConfig.rejectUnauthorized ?? true
  const sessionExpiryIntervalConfig = mqttConfig.sessionExpiryInterval
  const rawSessionExpiryInterval =
    typeof sessionExpiryIntervalConfig === 'object' &&
    sessionExpiryIntervalConfig !== null &&
    'env' in sessionExpiryIntervalConfig
      ? process.env[(sessionExpiryIntervalConfig as { env: string }).env]
      : sessionExpiryIntervalConfig
  if (
    rawSessionExpiryInterval !== undefined &&
    typeof rawSessionExpiryInterval !== 'number' &&
    typeof rawSessionExpiryInterval !== 'string'
  ) {
    throw new Error('mqtt.sessionExpiryInterval must be an integer between 1 and 4294967294')
  }
  const sessionExpiryInterval =
    rawSessionExpiryInterval === undefined ? undefined : Number(rawSessionExpiryInterval)
  if (
    sessionExpiryInterval !== undefined &&
    (!Number.isInteger(sessionExpiryInterval) ||
      sessionExpiryInterval < 1 ||
      sessionExpiryInterval > 0xfffffffe)
  ) {
    throw new Error('mqtt.sessionExpiryInterval must be an integer between 1 and 4294967294')
  }

  // Read and inline CA certificate if specified
  let caCert: string | undefined
  const caPath = resolveConfigValue(mqttConfig.caPath)
  if (caPath && typeof caPath === 'string') {
    const resolvedCaPath = path.isAbsolute(caPath) ? caPath : path.resolve(configDir, caPath)
    if (fs.existsSync(resolvedCaPath)) {
      caCert = fs.readFileSync(resolvedCaPath, 'utf-8')
      console.log(`   ✅ Inlined CA certificate from ${caPath} (${caCert.length} bytes)`)
    } else {
      console.warn(`   ⚠️  CA certificate not found at ${resolvedCaPath}, skipping`)
    }
  }

  const configContent = `// Auto-generated config for mobile consumer
// This file is generated at build time and should not be edited manually

export interface MobileConsumerConfig {
  mqtt: {
    protocol: string;
    host: string;
    port: string;
    path: string;
    username?: string;
    password?: string;
    ca?: string;
    rejectUnauthorized: boolean;
    sessionExpiryInterval?: number;
  };
  runId: string;
}

export const config: MobileConsumerConfig = {
  mqtt: {
    protocol: ${JSON.stringify(protocol)},
    host: ${JSON.stringify(host)},
    port: ${JSON.stringify(port)},
    path: ${JSON.stringify(mqttPath)},
    username: ${JSON.stringify(username)},
    password: ${JSON.stringify(password)},
    ca: ${JSON.stringify(caCert)},
    rejectUnauthorized: ${rejectUnauthorized},
    sessionExpiryInterval: ${JSON.stringify(sessionExpiryInterval)},
  },
  runId: ${JSON.stringify(runId)},
};
`

  fs.writeFileSync(path.join(outputDir, 'consumer-config.ts'), configContent)
  console.log(`   ✅ Generated consumer-config.ts`)

  // Return CA cert for use in Android network security config
  return caCert
}

export async function buildConsumerMobile(options: MobileBuildOptions) {
  try {
    console.log(`🔨 Building mobile consumer for ${options.platform}\n`)

    // Load configuration
    const configDir = path.resolve(options.config)

    // Load .env file from config directory
    loadDotenv({ path: path.join(configDir, '.env') })

    const config = await loadConfig(configDir)

    if (!config.consumers?.mobile) {
      throw new Error('No mobile consumer configuration found in qvac-test.config.js')
    }

    const mobileConfig = config.consumers.mobile
    const runId = options.runId || `mobile-${Date.now()}`

    // Resolve paths
    const entryPath = path.resolve(configDir, mobileConfig.entry)
    const outputDir = path.resolve(configDir, 'build/consumers', options.platform)
    const templateDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../templates/mobile-consumer'
    )

    console.log(`📂 Entry point: ${mobileConfig.entry}`)
    console.log(`📦 Output directory: ${outputDir}\n`)

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true })

    // Clean generated files to ensure fresh config from current env
    const generatedFiles = [
      'consumer-config.ts',
      'app.json',
      'executor.js',
      'assets.ts',
      'proc-mem-worklet.bundle.mjs'
    ]
    for (const file of generatedFiles) {
      const filePath = path.join(outputDir, file)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    // Clean stale qvac.config.* from a previous build (e.g. a different qvacConfig setting)
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isFile() && QVAC_CONFIG_PATTERN.test(entry.name)) {
        fs.unlinkSync(path.join(outputDir, entry.name))
      }
    }

    // Copy template files
    console.log('📋 Copying template files...')
    copyTemplateFiles(
      templateDir,
      outputDir,
      mobileConfig.mobileInit,
      mobileConfig.metroConfig,
      configDir
    )

    // Copy qvac.config.* so SDK bundler plugins (e.g. withMobileBundle) can find it during expo prebuild
    copyQvacConfigFiles(configDir, outputDir, mobileConfig.qvacConfig)

    // Validate MQTT protocol for mobile (only ws/wss supported)
    if (config.mqtt?.broker?.protocol) {
      const protocol =
        typeof config.mqtt.broker.protocol === 'object' && 'env' in config.mqtt.broker.protocol
          ? process.env[config.mqtt.broker.protocol.env] || ''
          : config.mqtt.broker.protocol

      if (protocol && protocol !== 'ws' && protocol !== 'wss') {
        throw new Error(
          `Mobile consumers only support ws/wss protocols, got: ${protocol}. MQTT/MQTTS are not supported by React Native.`
        )
      }
    }

    // Generate config.ts file with baked config
    console.log('⚙️  Generating config file...')
    const caCertForAndroid = generateMobileConfigFile(config, runId, outputDir, configDir)
    console.log(`   Run ID: ${runId}`)

    // Generate asset declarations if assets are configured
    if (mobileConfig.assets?.patterns && mobileConfig.assets.patterns.length > 0) {
      console.log('🎨 Generating asset declarations...')
      await generateAssetDeclarations(configDir, outputDir, mobileConfig.assets.patterns)
    }

    // Bundle user's executor (include shared code if configured)
    console.log('📦 Bundling executor...')
    const allIncludes = [...mobileConfig.include, ...(config.consumers?.shared?.include ?? [])]
    await bundleExecutor(entryPath, outputDir, configDir, allIncludes, config)

    // Generate package.json with dependencies
    console.log('📦 Setting up dependencies...')
    await generatePackageJson(configDir, outputDir, mobileConfig.dependencies)

    // Generate app.json with config
    console.log('⚙️  Configuring app.json...')
    generateAppJson(outputDir, options.platform, mobileConfig.expoPlugins, caCertForAndroid)

    // Install dependencies.
    // Use --install-links so file: deps (e.g. monorepo SDKs referenced via
    // file:..) are packed-and-copied instead of symlinked. Symlinking exposes
    // the linked package's own node_modules to Metro / Expo autolinking, which
    // can pull in transitive duplicates of react-native and friends.
    // Also persist install-links=true into .npmrc so manual reruns and nested
    // npm invocations (e.g. expo prebuild postinstall paths) inherit it.
    // CRITICAL: merge into any existing .npmrc rather than overwriting; CI
    // pipelines may pre-populate it with scoped registry auth.
    upsertNpmrcKeys(path.join(outputDir, '.npmrc'), {
      'install-links': 'true',
      'legacy-peer-deps': 'false'
    })
    console.log('📥 Installing dependencies (with --install-links)...')
    execSync('npm install --install-links=true', { cwd: outputDir, stdio: 'inherit' })

    patchPerformanceToolkitIosMemoryBuffer(outputDir, options.platform)

    // Pre-bundle the /proc memory sampling worklet with bare-pack. Must happen
    // after install (bare-pack + the linked bare-* deps are now present) and
    // before prebuild/Metro (consumer-wrapper statically imports the bundle).
    generateProcMemWorkletBundle(outputDir, options.platform)

    if (options.prepareOnly) {
      // Skip prebuild -- caller (e.g. expo run:ios) will handle prebuild + build + signing
      console.log(`\n✅ Prepared ${options.platform} consumer at: ${outputDir}`)
      return
    }

    // Run expo prebuild (--clean ensures native project reflects current config)
    console.log('\n🔧 Running expo prebuild...')
    execSync(`npx expo prebuild --clean --platform ${options.platform}`, {
      cwd: outputDir,
      stdio: 'inherit'
    })

    // Build the app
    console.log(`\n🏗️  Building ${options.platform} app...`)
    if (options.platform === 'android') {
      // Don't run gradle clean - it wipes out assets generated by expo plugins
      execSync('./gradlew assembleRelease', {
        cwd: path.join(outputDir, 'android'),
        stdio: 'inherit'
      })

      const apkPath = path.join(outputDir, 'android/app/build/outputs/apk/release/app-release.apk')

      if (fs.existsSync(apkPath)) {
        console.log(`\n✅ Build successful!`)
        console.log(`📦 APK: ${apkPath}`)

        // Copy APK to output root if configured
        if (mobileConfig.copyArtifact !== false) {
          fs.copyFileSync(apkPath, path.join(outputDir, 'consumer.apk'))
          console.log(`📋 Copied to: ${path.join(outputDir, 'consumer.apk')}`)
        }
      } else {
        throw new Error('APK file not found after build')
      }
    } else {
      // iOS build
      const iosDir = path.join(outputDir, 'ios')

      // Detect scheme from the generated Xcode project (expo prebuild already ran pod install)
      const listOutput = execSync('xcodebuild -list', { cwd: iosDir, encoding: 'utf-8' })
      const schemeMatch = listOutput.match(/Schemes:\s*\n\s*(.+)/)
      if (!schemeMatch) {
        throw new Error('Could not detect Xcode scheme from xcodebuild -list')
      }
      const scheme = schemeMatch[1].trim()
      console.log(`   Detected scheme: ${scheme}`)

      const archivePath = path.join(iosDir, 'build', `${scheme}.xcarchive`)
      const exportDir = path.join(iosDir, 'build', 'export')

      // Manual signing only when an explicit provisioning profile is provided (CI)
      const manualSigning = !!process.env.QVAC_IOS_PROVISIONING_PROFILE
      const teamId = process.env.QVAC_IOS_TEAM_ID || detectTeamIdFromKeychain()

      // Archive
      const archiveArgs = [
        'xcodebuild',
        `-workspace "${scheme}.xcworkspace"`,
        `-scheme "${scheme}"`,
        '-sdk iphoneos',
        '-configuration Release',
        '-destination "generic/platform=iOS"',
        `-archivePath "${archivePath}"`,
        '-quiet'
      ]

      if (manualSigning && teamId) {
        const identity = process.env.QVAC_IOS_CODE_SIGN_IDENTITY || 'Apple Distribution'
        const profileUuid = process.env.QVAC_IOS_PROVISIONING_PROFILE!
        archiveArgs.push(
          'CODE_SIGN_STYLE=Manual',
          `PROVISIONING_PROFILE_SPECIFIER="${profileUuid}"`,
          `CODE_SIGN_IDENTITY="${identity}"`,
          `DEVELOPMENT_TEAM="${teamId}"`
        )
        console.log('   Using manual signing (CI mode)')
      } else {
        // Team ID is injected via app.json (ios.appleTeamId) during prebuild
        archiveArgs.push('-allowProvisioningUpdates')
        console.log(`   Using automatic signing${teamId ? ` (team: ${teamId})` : ''}`)
      }

      archiveArgs.push('clean archive')
      execSync(archiveArgs.join(' '), { cwd: iosDir, stdio: 'inherit' })

      // Write ExportOptions.plist
      const bundleId = process.env.QVAC_IOS_BUNDLE_ID || 'io.tether.qvac-test-consumer-mobile'
      const exportMethod = process.env.QVAC_IOS_EXPORT_METHOD || 'development'
      const exportPlistPath = path.join(iosDir, 'build', 'ExportOptions.plist')

      let exportPlist: string
      if (manualSigning) {
        const profileUuid = process.env.QVAC_IOS_PROVISIONING_PROFILE || ''
        exportPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${exportMethod}</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${bundleId}</key>
    <string>${profileUuid}</string>
  </dict>
</dict>
</plist>`
      } else {
        exportPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${exportMethod}</string>${teamId ? `\n  <key>teamID</key>\n  <string>${teamId}</string>` : ''}
  <key>signingStyle</key>
  <string>automatic</string>
</dict>
</plist>`
      }

      fs.writeFileSync(exportPlistPath, exportPlist)

      // Export IPA
      fs.mkdirSync(exportDir, { recursive: true })
      execSync(
        `xcodebuild -exportArchive -archivePath "${archivePath}" -exportOptionsPlist "${exportPlistPath}" -exportPath "${exportDir}" -quiet`,
        { cwd: iosDir, stdio: 'inherit' }
      )

      // Find and copy IPA
      const exportFiles = fs.readdirSync(exportDir)
      const ipaFile = exportFiles.find((f) => f.endsWith('.ipa'))
      if (!ipaFile) {
        throw new Error(`IPA file not found in ${exportDir}`)
      }

      const ipaPath = path.join(exportDir, ipaFile)
      console.log(`\n✅ Build successful!`)
      console.log(`📦 IPA: ${ipaPath}`)

      if (mobileConfig.copyArtifact !== false) {
        fs.copyFileSync(ipaPath, path.join(outputDir, 'consumer.ipa'))
        console.log(`📋 Copied to: ${path.join(outputDir, 'consumer.ipa')}`)
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Build failed:', errorMessage)
    process.exit(1)
  }
}

const QVAC_CONFIG_PATTERN = /^qvac\.config\.\w+$/

/**
 * Copies qvac.config.* into the mobile build output for SDK Expo plugins to
 * discover during `expo prebuild`. An explicit `explicitPath` is required to
 * exist and must be a `.json` file — it is copied as the canonical
 * `qvac.config.json` and parsed as JSON by the SDK config loader, so a missing
 * or non-JSON path is a hard error rather than a silent fallback. When
 * `explicitPath` is omitted, all qvac.config.* in `configDir` are copied as-is.
 */
function copyQvacConfigFiles(configDir: string, outputDir: string, explicitPath?: string): void {
  if (explicitPath) {
    const src = path.isAbsolute(explicitPath) ? explicitPath : path.join(configDir, explicitPath)

    if (!fs.existsSync(src)) {
      throw new Error(`qvacConfig path not found: ${explicitPath}`)
    }

    if (path.extname(src) !== '.json') {
      throw new Error(
        `qvacConfig must point to a .json file (got "${explicitPath}"); it is copied as ` +
          `qvac.config.json and parsed as JSON by the SDK config loader.`
      )
    }

    const dest = path.join(outputDir, 'qvac.config.json')
    fs.copyFileSync(src, dest)
    console.log(`   ✅ Copied ${explicitPath} → qvac.config.json`)
    return
  }

  const entries = fs.readdirSync(configDir, { withFileTypes: true })
  let copied = 0

  for (const entry of entries) {
    if (!entry.isFile() || !QVAC_CONFIG_PATTERN.test(entry.name)) continue
    fs.copyFileSync(path.join(configDir, entry.name), path.join(outputDir, entry.name))
    copied++
    console.log(`   ✅ Copied ${entry.name}`)
  }

  if (copied === 0) {
    console.log(
      '   ℹ️  No qvac.config.* files found in project root — SDK will use default plugin set'
    )
  }
}

// The framework is published under two names — @qvac/test-suite (public npm)
// and @tetherto/test-suite-mono (GitHub Packages) — from the same source.
// The pre-monorepo names (@qvac/qvac-test-suite, @tetherto/qvac-test-suite) are
// still accepted so a consumer pinned to a released 0.10.x keeps working.
// Templates copied verbatim into a generated app can only import whatever name
// the consumer actually installed, so resolve that here and rewrite the import
// specifier at scaffold time. Prefer the consumer's declared dependency, fall
// back to what's on disk, then to the canonical public name.
const FRAMEWORK_PACKAGE_NAMES = [
  '@qvac/test-suite',
  '@tetherto/test-suite-mono',
  '@qvac/qvac-test-suite',
  '@tetherto/qvac-test-suite'
] as const
const FRAMEWORK_SPECIFIER_RE = /@(?:qvac|tetherto)\/(?:qvac-)?test-suite(?:-mono)?/g

function resolveFrameworkPackageName(configDir?: string): string {
  if (configDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(configDir, 'package.json'), 'utf-8'))
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {})
      }
      for (const name of FRAMEWORK_PACKAGE_NAMES) {
        if (deps[name]) return name
      }
    } catch {}
    for (const name of FRAMEWORK_PACKAGE_NAMES) {
      if (fs.existsSync(path.join(configDir, 'node_modules', ...name.split('/')))) return name
    }
  }
  return FRAMEWORK_PACKAGE_NAMES[0]
}

function copyTemplateFiles(
  templateDir: string,
  outputDir: string,
  mobileInitPath?: string,
  metroConfigPath?: string,
  configDir?: string
): void {
  // Generated apps only have the framework under the name the consumer
  // installed; rewrite template import specifiers to match it.
  const frameworkPackage = resolveFrameworkPackageName(configDir)

  const files = [
    'App.tsx',
    'batch-consumer.tsx',
    'consumer-wrapper.tsx',
    'proc-mem-worklet.mjs',
    'metro.config.js',
    'babel.config.js'
  ]

  for (const file of files) {
    // Skip metro.config.js if user provides custom one
    if (file === 'metro.config.js' && metroConfigPath) {
      continue
    }

    const src = path.join(templateDir, file)
    const dest = path.join(outputDir, file)

    if (file === 'App.tsx') {
      let content = fs.readFileSync(src, 'utf-8')

      // Handle mobileInit placeholder replacement if specified
      if (mobileInitPath) {
        const mobileInitBasename = path.basename(mobileInitPath, path.extname(mobileInitPath))
        content = content.replace(
          '// MOBILE_INIT_IMPORT_PLACEHOLDER',
          `import { __sdkPreload } from './${mobileInitBasename}';`
        )
        content = content.replace(
          '// MOBILE_INIT_REFERENCE_PLACEHOLDER',
          `if (__DEV__ && __sdkPreload) { console.log('SDK preloaded'); }`
        )
      } else {
        // Remove placeholders if no mobileInit
        content = content.replace('// MOBILE_INIT_IMPORT_PLACEHOLDER\n', '')
        content = content.replace('  // MOBILE_INIT_REFERENCE_PLACEHOLDER\n', '')
      }

      fs.writeFileSync(dest, content)
    } else if (file === 'consumer-wrapper.tsx') {
      // Copied verbatim into the generated app, which only has the framework
      // under the installed name — rewrite the import specifier to match so both
      // the @qvac (npm) and @tetherto (GPR) tarballs stay self-consistent.
      const content = fs
        .readFileSync(src, 'utf-8')
        .replace(FRAMEWORK_SPECIFIER_RE, frameworkPackage)
      fs.writeFileSync(dest, content)
    } else {
      fs.copyFileSync(src, dest)
    }
  }

  // Copy mobileInit file if specified
  if (mobileInitPath && configDir) {
    const mobileInitSrc = path.join(configDir, mobileInitPath)
    if (fs.existsSync(mobileInitSrc)) {
      const mobileInitBasename = path.basename(mobileInitPath)
      const mobileInitDest = path.join(outputDir, mobileInitBasename)
      fs.copyFileSync(mobileInitSrc, mobileInitDest)
      console.log(`📱 Copied mobile init: ${mobileInitBasename}`)
    } else {
      console.warn(`⚠️  Mobile init file not found: ${mobileInitPath}`)
    }
  }

  // Copy custom Metro config if specified
  if (metroConfigPath && configDir) {
    const metroConfigSrc = path.join(configDir, metroConfigPath)
    if (fs.existsSync(metroConfigSrc)) {
      const metroConfigDest = path.join(outputDir, 'metro.config.js')
      fs.copyFileSync(metroConfigSrc, metroConfigDest)
      console.log(`⚙️  Copied custom Metro config: ${metroConfigPath}`)
    } else {
      console.warn(`⚠️  Metro config file not found: ${metroConfigPath}`)
    }
  }

  // Copy plugins directory
  const pluginsDir = path.join(templateDir, 'plugins')
  const destPluginsDir = path.join(outputDir, 'plugins')
  if (fs.existsSync(pluginsDir)) {
    fs.mkdirSync(destPluginsDir, { recursive: true })
    const pluginFiles = fs.readdirSync(pluginsDir)
    for (const pluginFile of pluginFiles) {
      fs.copyFileSync(path.join(pluginsDir, pluginFile), path.join(destPluginsDir, pluginFile))
    }
  }
}

// Exact react-native-performance-toolkit version this iOS patch was written
// against. The block matching in patchPerformanceToolkitIosMemoryBuffer depends
// on the upstream Swift source verbatim; the version is pinned in
// package.json.template and enforced via npm overrides (see generatePackageJson).
// If the pin is ever bumped, the patch must be re-verified against the new
// source and this constant updated in lockstep.
const EXPECTED_PERFORMANCE_TOOLKIT_VERSION = '0.3.1'

/**
 * Extend react-native-performance-toolkit's existing iOS memory buffer in the
 * generated app project. The public Nitro method still returns ArrayBuffer and
 * the first Int32 remains phys_footprint MB for compatibility with the package's
 * getMemoryUsage() helper; QVAC reads the appended Float64 fields (resident_size,
 * region_count) directly. virtual_size is intentionally not collected.
 */
function patchPerformanceToolkitIosMemoryBuffer(
  outputDir: string,
  platform: 'ios' | 'android'
): void {
  if (platform !== 'ios') return

  const packageRoot = path.join(outputDir, 'node_modules', 'react-native-performance-toolkit')
  const swiftPath = path.join(packageRoot, 'ios', 'HybridPerformanceToolkit.swift')
  if (!fs.existsSync(swiftPath)) {
    console.warn(
      '   ⚠️  react-native-performance-toolkit iOS source not found; iOS VM metrics disabled'
    )
    return
  }

  // Loud signal on version drift: the block matches below silently no-op on a
  // changed upstream source, which would quietly drop the iOS resident_size /
  // region_count series. A version mismatch means the patch must be re-verified.
  let installedVersion: string | undefined
  try {
    installedVersion = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
    ).version
  } catch {
    // Fall through; the block-match guards below still protect correctness.
  }
  if (installedVersion && installedVersion !== EXPECTED_PERFORMANCE_TOOLKIT_VERSION) {
    console.warn(
      `   ⚠️  react-native-performance-toolkit@${installedVersion} differs from the pinned ${EXPECTED_PERFORMANCE_TOOLKIT_VERSION}; ` +
        're-verify patchPerformanceToolkitIosMemoryBuffer against the new source and update EXPECTED_PERFORMANCE_TOOLKIT_VERSION. iOS VM metrics may be disabled.'
    )
  }

  let content = fs.readFileSync(swiftPath, 'utf8')
  if (content.includes('QVAC_VM_INFO_BUFFER_SIZE')) {
    console.log('   ✅ iOS VM memory buffer already patched')
    return
  }

  const memoryTrackingBlock = `    // Memory tracking
    private var memoryTimer: Timer?
    private var memoryBuffer: ArrayBuffer?
    private var isMemoryTrackingStarting = false
`
  const patchedMemoryTrackingBlock = `    // Memory tracking
    private static let QVAC_VM_INFO_BUFFER_SIZE = 24
    private static let QVAC_VM_INFO_PHYS_FOOTPRINT_MB_OFFSET = 0
    private static let QVAC_VM_INFO_RESIDENT_SIZE_KB_OFFSET = 8
    private static let QVAC_VM_INFO_REGION_COUNT_OFFSET = 16
    private var memoryTimer: Timer?
    private var memoryBuffer: ArrayBuffer?
    private var isMemoryTrackingStarting = false
`

  const memoryBufferBlock = `        if memoryBuffer == nil {
            memoryBuffer = ArrayBuffer.allocate(size: MemoryLayout<Int32>.size)
            memoryBuffer!.data.withMemoryRebound(to: Int32.self, capacity: 1) { $0.pointee = 0 }
        }
`
  const patchedMemoryBufferBlock = `        if memoryBuffer == nil {
            memoryBuffer = ArrayBuffer.allocate(size: Self.QVAC_VM_INFO_BUFFER_SIZE)
            memset(memoryBuffer!.data, 0, Self.QVAC_VM_INFO_BUFFER_SIZE)
        }
`

  const memoryMethodsBlock = `    private func updateMemoryBuffer() {
        guard let buffer = memoryBuffer else { return }
        
        let ramValue = collectUsedRam()
        
        buffer.data.withMemoryRebound(to: Int32.self, capacity: 1) { $0.pointee = Int32(ramValue) }
    }
    
    private func collectUsedRam() -> Double {
        // Use task_vm_info to get phys_footprint, which matches Xcode's memory gauge
        // This excludes shared memory (frameworks, dylibs) and shows actual app footprint
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size) / 4
        
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        
        guard result == KERN_SUCCESS else {
            return 0.0
        }
        
        return Double(info.phys_footprint) / 1_048_576.0
    }
`
  const patchedMemoryMethodsBlock = `    private struct QvacTaskVmInfoSample {
        let physFootprintMb: Double?
        let residentSizeKb: Double?
        let regionCount: Double?
    }
    
    private func updateMemoryBuffer() {
        guard let buffer = memoryBuffer else { return }
        
        let sample = collectQvacTaskVmInfo()
        
        buffer.data.advanced(by: Self.QVAC_VM_INFO_PHYS_FOOTPRINT_MB_OFFSET)
            .withMemoryRebound(to: Int32.self, capacity: 1) {
                $0.pointee = Int32(sample.physFootprintMb ?? 0.0)
            }
        writeQvacDouble(buffer, offset: Self.QVAC_VM_INFO_RESIDENT_SIZE_KB_OFFSET, value: sample.residentSizeKb ?? 0.0)
        writeQvacDouble(buffer, offset: Self.QVAC_VM_INFO_REGION_COUNT_OFFSET, value: sample.regionCount ?? 0.0)
    }
    
    private func writeQvacDouble(_ buffer: ArrayBuffer, offset: Int, value: Double) {
        var mutableValue = value
        withUnsafeBytes(of: &mutableValue) { bytes in
            memcpy(buffer.data.advanced(by: offset), bytes.baseAddress!, MemoryLayout<Double>.size)
        }
    }
    
    private func qvacTaskVmInfoCountCovers<T>(_ field: KeyPath<task_vm_info_data_t, T>, count: mach_msg_type_number_t) -> Bool {
        guard let offset = MemoryLayout<task_vm_info_data_t>.offset(of: field) else {
            return false
        }
        let wordSize = MemoryLayout<natural_t>.size
        let requiredCount = mach_msg_type_number_t((offset + MemoryLayout<T>.size + wordSize - 1) / wordSize)
        return count >= requiredCount
    }
    
    private func collectQvacTaskVmInfo() -> QvacTaskVmInfoSample {
        // TASK_VM_INFO gives phys_footprint plus resident size and region count.
        // Swift does not import the TASK_VM_INFO_COUNT macro, so compute the same
        // natural_t word count and verify the returned revision covers each late
        // field before reading it. virtual_size is intentionally not read: it
        // measures reserved-but-uncommitted address space and is useless as a
        // memory-usage signal.
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        
        guard result == KERN_SUCCESS else {
            return QvacTaskVmInfoSample(physFootprintMb: nil, residentSizeKb: nil, regionCount: nil)
        }
        
        let physFootprintMb: Double?
        if qvacTaskVmInfoCountCovers(\\task_vm_info_data_t.phys_footprint, count: count) {
            physFootprintMb = Double(info.phys_footprint) / 1_048_576.0
        } else {
            physFootprintMb = nil
        }
        
        let residentSizeKb: Double?
        if qvacTaskVmInfoCountCovers(\\task_vm_info_data_t.resident_size, count: count) {
            residentSizeKb = Double(info.resident_size) / 1024.0
        } else {
            residentSizeKb = nil
        }
        
        let regionCount: Double?
        if qvacTaskVmInfoCountCovers(\\task_vm_info_data_t.region_count, count: count) {
            regionCount = Double(info.region_count)
        } else {
            regionCount = nil
        }
        
        return QvacTaskVmInfoSample(
            physFootprintMb: physFootprintMb,
            residentSizeKb: residentSizeKb,
            regionCount: regionCount
        )
    }
    
    private func collectUsedRam() -> Double {
        return collectQvacTaskVmInfo().physFootprintMb ?? 0.0
    }
`

  if (
    !content.includes(memoryTrackingBlock) ||
    !content.includes(memoryBufferBlock) ||
    !content.includes(memoryMethodsBlock)
  ) {
    console.warn(
      '   ⚠️  Could not patch react-native-performance-toolkit iOS memory buffer; iOS VM metrics disabled'
    )
    return
  }

  content = content
    .replace(memoryTrackingBlock, patchedMemoryTrackingBlock)
    .replace(memoryBufferBlock, patchedMemoryBufferBlock)
    .replace(memoryMethodsBlock, patchedMemoryMethodsBlock)

  if (
    !content.includes('QVAC_VM_INFO_BUFFER_SIZE') ||
    !content.includes('collectQvacTaskVmInfo') ||
    content.includes('memoryBuffer = ArrayBuffer.allocate(size: MemoryLayout<Int32>.size)')
  ) {
    console.warn(
      '   ⚠️  Could not patch react-native-performance-toolkit iOS memory buffer; iOS VM metrics disabled'
    )
    return
  }

  fs.writeFileSync(swiftPath, content)
  console.log('   ✅ Patched iOS memory buffer for task_vm_info resident size + region count')
}

/**
 * Pre-bundle the Bare /proc memory sampling worklet with `bare-pack`.
 *
 * `consumer-wrapper.tsx` statically imports `./proc-mem-worklet.bundle.mjs`, so
 * the file must always exist by the time Metro bundles — even on iOS (where the
 * sampler is inert) or when bundling fails. In those cases we write a stub that
 * exports `null`; the wrapper guards on a falsy bundle and simply skips the
 * extra series.
 *
 * The worklet is Android-only (iOS has no /proc), so we only invoke bare-pack
 * for Android builds. `--linked` reuses the native addons linked ahead of time
 * by react-native-bare-kit rather than recompiling them.
 */
function generateProcMemWorkletBundle(outputDir: string, platform: 'ios' | 'android'): void {
  const entry = path.join(outputDir, 'proc-mem-worklet.mjs')
  const bundleOut = path.join(outputDir, 'proc-mem-worklet.bundle.mjs')
  const stub = 'export default null\n'

  if (platform !== 'android' || !fs.existsSync(entry)) {
    fs.writeFileSync(bundleOut, stub)
    return
  }

  try {
    console.log('🧵 Bundling /proc memory worklet (bare-pack)...')
    // bare-pack targets a host triple via --host (the Android consumer is built
    // arm64-v8a only, see withAndroidArchitecture in the expo config), and
    // --linked defers native addon (bare-fs/bare-rpc) resolution to the app's
    // own native linking rather than bundling prebuilt binaries.
    execSync(`npx bare-pack --host android-arm64 --linked --out "${bundleOut}" "${entry}"`, {
      cwd: outputDir,
      stdio: 'inherit'
    })
    if (!fs.existsSync(bundleOut)) {
      throw new Error('bare-pack produced no output')
    }
    console.log('   ✅ Worklet bundle generated')
  } catch (e) {
    console.warn(
      `   ⚠️  Worklet bundling failed (${(e as Error).message}); /proc memory series disabled`
    )
    fs.writeFileSync(bundleOut, stub)
  }
}

// lunte-disable-next-line require-await
async function bundleExecutor(
  entryPath: string,
  outputDir: string,
  configDir: string,
  includePatterns: string[],
  config: QvacTestConfig
): Promise<void> {
  // Copy all test files that the executor depends on
  for (const pattern of includePatterns) {
    // Simple pattern handling: ./tests/** means copy tests directory
    const cleanPattern = pattern.replace(/\/\*\*.*$/, '')
    const srcDir = path.join(configDir, cleanPattern)

    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      const destDir = path.join(outputDir, cleanPattern)
      copyDirectoryRecursive(srcDir, destDir)
    }
  }

  // Create executor.js that re-exports all from the copied entry file
  const relativeEntry = path.relative(configDir, entryPath)
  const executorContent = `// Bundled executor entry point
export * from './${relativeEntry.replace(/\.ts$/, '')}';
`
  fs.writeFileSync(path.join(outputDir, 'executor.js'), executorContent)

  // Create test-definitions.js that re-exports from the test definitions file
  const testDir = path.resolve(configDir, config.testDir)
  const tsDefsPath = path.join(testDir, 'test-definitions.ts')
  const jsDefsPath = path.join(testDir, 'test-definitions.js')
  const defsPath = fs.existsSync(jsDefsPath)
    ? jsDefsPath
    : fs.existsSync(tsDefsPath)
      ? tsDefsPath
      : null

  if (defsPath) {
    const relativeDefs = path.relative(configDir, defsPath)
    const testDefsContent = `// Bundled test definitions entry point
export { tests, default } from './${relativeDefs.replace(/\.ts$/, '')}';
`
    fs.writeFileSync(path.join(outputDir, 'test-definitions.js'), testDefsContent)
    console.log(`   ✅ Generated test-definitions.js`)
  } else {
    console.warn(
      `   ⚠️  No test-definitions.ts/.js found in ${testDir} — consumer will not have local test definitions`
    )
  }
}

/**
 * Idempotently set keys in an .npmrc file.
 * - If the file does not exist, creates it with just the given keys.
 * - If a key already exists (uncommented), its value is replaced.
 * - If a key is missing, it is appended.
 * - Preserves all unrelated lines, comments, ordering, and trailing newline.
 *
 * Note: only handles plain `key=value` lines. Section-scoped keys
 * (e.g. `@scope:registry=...`) are matched literally as-is.
 */
function upsertNpmrcKeys(npmrcPath: string, keys: Record<string, string>): void {
  const content = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : ''
  const hadTrailingNewline = content.endsWith('\n')
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')

  for (const [key, value] of Object.entries(keys)) {
    // Match `key = value` / `key=value`, allowing leading whitespace; ignore commented (#) lines.
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`)
    const idx = lines.findIndex((l) => !l.trimStart().startsWith('#') && re.test(l))
    if (idx >= 0) {
      lines[idx] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
  }

  fs.writeFileSync(
    npmrcPath,
    lines.join('\n') + (hadTrailingNewline || lines.length > 0 ? '\n' : '')
  )
}

function copyDirectoryRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })

  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// lunte-disable-next-line require-await
async function generatePackageJson(
  configDir: string,
  outputDir: string,
  dependencies: 'auto' | Record<string, string> | undefined
): Promise<void> {
  // Read template
  const templatePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../../templates/mobile-consumer/package.json.template'
  )
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  // Add user dependencies
  if (dependencies === 'auto') {
    const userPkgPath = path.join(configDir, 'package.json')
    if (fs.existsSync(userPkgPath)) {
      const userPkg = JSON.parse(fs.readFileSync(userPkgPath, 'utf-8'))
      const userDeps = userPkg.dependencies || {}

      // Adjust file: paths to be relative to output directory
      const adjustedDeps: Record<string, string> = {}
      for (const [name, version] of Object.entries(userDeps)) {
        if (typeof version === 'string' && version.startsWith('file:')) {
          const relativePath = version.replace('file:', '')
          const absolutePath = path.resolve(configDir, relativePath)
          const relativeFromOutput = path.relative(outputDir, absolutePath)
          const normalizedPath = relativeFromOutput.split(path.sep).join('/')
          adjustedDeps[name] = `file:${normalizedPath}`
        } else {
          adjustedDeps[name] = version as string
        }
      }

      template.dependencies = {
        ...template.dependencies,
        ...adjustedDeps
      }
    }
  } else if (dependencies) {
    template.dependencies = {
      ...template.dependencies,
      ...dependencies
    }
  }

  // Pin RN-stack versions across the entire dependency graph via npm overrides.
  // Without this, transitive peer ranges like react-native-bare-kit's
  // `react-native: *` can pull in a different react-native at install time.
  // react-native-performance-toolkit is pinned too because the iOS build patches
  // its Swift source verbatim (see patchPerformanceToolkitIosMemoryBuffer /
  // EXPECTED_PERFORMANCE_TOOLKIT_VERSION); an unexpected version silently breaks
  // that patch.
  const pinned = [
    'react',
    'react-native',
    'react-native-bare-kit',
    'react-native-performance-toolkit'
  ]
  const overrides: Record<string, string> = { ...(template.overrides ?? {}) }
  for (const name of pinned) {
    const v = template.dependencies?.[name]
    if (typeof v === 'string' && v.length > 0) {
      overrides[name] = v
    }
  }
  if (Object.keys(overrides).length > 0) {
    template.overrides = overrides
  }

  fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify(template, null, 2))
}

function generateAppJson(
  outputDir: string,
  platform: string,
  userPlugins?: Array<string | [string, unknown]>,
  caCert?: string
): void {
  const templatePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../../templates/mobile-consumer/app.json.template'
  )

  const appConfig = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  appConfig.expo.name = process.env.QVAC_APP_NAME || 'QVAC Test Consumer'
  appConfig.expo.slug = process.env.QVAC_APP_SLUG || 'qvac-test-consumer-mobile'
  appConfig.expo.ios.bundleIdentifier =
    process.env.QVAC_IOS_BUNDLE_ID || 'io.tether.qvac-test-consumer-mobile'
  appConfig.expo.android.package =
    process.env.QVAC_ANDROID_PACKAGE || 'io.tether.qvac_test_consumer_mobile'

  const iosTeamId = process.env.QVAC_IOS_TEAM_ID || detectTeamIdFromKeychain()
  if (iosTeamId) {
    appConfig.expo.ios.appleTeamId = iosTeamId
  }

  // Update withNetworkSecurityConfig plugin to include CA cert if provided
  const networkSecurityPluginIndex = appConfig.expo.plugins.findIndex(
    (p: string | [string, unknown]) =>
      typeof p === 'string' && p.includes('withNetworkSecurityConfig')
  )

  if (networkSecurityPluginIndex !== -1 && caCert) {
    // Replace string plugin reference with array [plugin, caCert]
    appConfig.expo.plugins[networkSecurityPluginIndex] = [
      './plugins/withNetworkSecurityConfig.js',
      caCert
    ]
    console.log(`   ✅ Configured network security with custom CA certificate`)
  }

  // Add user-specified expo plugins if provided
  // Insert them BEFORE expo-asset to ensure they run early in the pipeline
  if (userPlugins && userPlugins.length > 0) {
    const assetPluginIndex = appConfig.expo.plugins.findIndex(
      (p: string | [string, unknown]) => p === 'expo-asset'
    )
    if (assetPluginIndex !== -1) {
      appConfig.expo.plugins.splice(assetPluginIndex, 0, ...userPlugins)
    } else {
      appConfig.expo.plugins.push(...userPlugins)
    }
  }

  fs.writeFileSync(path.join(outputDir, 'app.json'), JSON.stringify(appConfig, null, 2))
}

// lunte-disable-next-line require-await
async function generateAssetDeclarations(
  configDir: string,
  outputDir: string,
  assetPatterns: string[]
): Promise<void> {
  const assetsByCategory: Record<string, Record<string, string>> = {}

  // Copy assets into build directory and track them
  function copyAssets(sourceDir: string, category: string, destCategoryDir: string) {
    if (!fs.existsSync(sourceDir)) {
      return
    }

    fs.mkdirSync(destCategoryDir, { recursive: true })

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name)
      if (entry.isDirectory()) {
        const subDestDir = path.join(destCategoryDir, entry.name)
        copyAssets(sourcePath, category, subDestDir)
      } else if (entry.isFile()) {
        const destPath = path.join(destCategoryDir, entry.name)
        fs.copyFileSync(sourcePath, destPath)

        if (!assetsByCategory[category]) {
          assetsByCategory[category] = {}
        }
        // Store relative path from output root
        const relativePath = path.relative(outputDir, destPath)
        assetsByCategory[category][entry.name] = relativePath
      }
    }
  }

  // Process each pattern
  for (const pattern of assetPatterns) {
    const parts = pattern.split('/').filter((p) => p && p !== '.' && p !== '**' && p !== '*')

    // Extract category (e.g., './assets/audio/**/*' → 'audio')
    const category = parts.length >= 2 ? parts[1] : 'other'
    const sourceDir = path.join(configDir, ...parts.slice(0, 2))
    const destCategoryDir = path.join(outputDir, 'assets', category)

    copyAssets(sourceDir, category, destCategoryDir)
  }

  // Generate TypeScript file with asset exports
  const lines = [
    '// Auto-generated asset declarations - DO NOT EDIT',
    '// Generated during mobile consumer build',
    ''
  ]

  for (const [category, files] of Object.entries(assetsByCategory)) {
    lines.push(`export const ${category} = {`)
    for (const [filename, relativePath] of Object.entries(files)) {
      lines.push(`  '${filename}': require('./${relativePath.replace(/\\/g, '/')}'),`)
    }
    lines.push('};')
    lines.push('')
  }

  if (Object.keys(assetsByCategory).length === 0) {
    lines.push('// No assets found')
  }

  // Write to assets.ts in output directory
  const assetsFilePath = path.join(outputDir, 'assets.ts')
  fs.writeFileSync(assetsFilePath, lines.join('\n'))

  console.log(`   Generated assets.ts with ${Object.keys(assetsByCategory).length} categories`)
  for (const [category, files] of Object.entries(assetsByCategory)) {
    console.log(`     - ${category}: ${Object.keys(files).length} files`)
  }
}
