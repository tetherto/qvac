import { execSync } from 'node:child_process'

export interface AndroidDevice {
  serial: string
  state: string
}

export interface IosDevice {
  udid: string
  name: string
}

/**
 * Detect connected Android devices via `adb devices`.
 * Works on macOS, Linux, and Windows.
 */
export function detectAndroidDevices(): AndroidDevice[] {
  try {
    const output = execSync('adb devices', { encoding: 'utf-8', timeout: 10000 })
    const lines = output.split('\n').slice(1) // skip header
    const devices: AndroidDevice[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length >= 2 && parts[1] === 'device') {
        devices.push({ serial: parts[0], state: parts[1] })
      }
    }
    return devices
  } catch {
    return []
  }
}

/**
 * Install an APK on an Android device.
 */
export function installAndroidApk(serial: string, apkPath: string): void {
  console.log(`📦 Installing APK on ${serial}...`)
  execSync(`adb -s ${serial} install -r "${apkPath}"`, { stdio: 'inherit', timeout: 120000 })
  console.log('✅ APK installed')
}

/**
 * Launch an Android app by package name.
 */
export function launchAndroidApp(serial: string, packageName: string): void {
  console.log(`🚀 Launching ${packageName} on ${serial}...`)
  execSync(`adb -s ${serial} shell am start -n ${packageName}/.MainActivity`, {
    stdio: 'inherit',
    timeout: 15000
  })
  console.log('✅ App launched')
}

/**
 * Get the PID of a running Android app.
 */
export function getAndroidAppPid(serial: string, packageName: string): number | undefined {
  try {
    const output = execSync(`adb -s ${serial} shell pidof ${packageName}`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim()
    const pid = parseInt(output, 10)
    return isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

/**
 * Auto-detect the Apple development team ID from the keychain.
 * Extracts the OU (Organizational Unit) field from the certificate subject,
 * which is the actual team ID (distinct from the cert serial shown in parens).
 * macOS only.
 */
export function detectAppleTeamId(): string | undefined {
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

  // Fallback: try "iPhone Developer" cert name (older Xcode)
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

function requireMacOS(operation: string): void {
  if (process.platform !== 'darwin') {
    console.error(`\n❌ ${operation} requires macOS with Xcode installed.\n`)
    process.exit(1)
  }
}

/**
 * Detect connected iOS devices via `xcrun devicectl`.
 * macOS only.
 */
export function detectIosDevices(): IosDevice[] {
  requireMacOS('iOS device detection')

  try {
    const output = execSync(
      'xcrun devicectl list devices --hide-default-columns --columns Name --columns UDID 2>/dev/null',
      { encoding: 'utf-8', timeout: 15000 }
    )

    const devices: IosDevice[] = []
    const lines = output.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Skip header lines and separator lines
      if (
        trimmed.startsWith('--') ||
        trimmed.startsWith('==') ||
        trimmed.toLowerCase().includes('name')
      ) {
        continue
      }

      // Format: "Name    UDID" (tab or multi-space separated)
      const match = trimmed.match(/^(.+?)\s{2,}(\S+)$/)
      if (match) {
        devices.push({ name: match[1].trim(), udid: match[2].trim() })
      }
    }
    return devices
  } catch {
    // Fallback: try ios-deploy for older Xcode versions
    try {
      const output = execSync('ios-deploy -c --no-wifi 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 15000
      })
      const devices: IosDevice[] = []
      for (const line of output.split('\n')) {
        const match = line.match(/\[.*?\]\s+Found\s+(\S+)\s+\(([^)]+)\)/)
        if (match) {
          devices.push({ udid: match[1], name: match[2] })
        }
      }
      return devices
    } catch {
      return []
    }
  }
}

/**
 * Install an app on an iOS device.
 * macOS only. Tries xcrun devicectl first, falls back to ios-deploy.
 */
export function installIosApp(udid: string, appPath: string): void {
  requireMacOS('iOS app installation')

  console.log(`📦 Installing app on ${udid}...`)

  try {
    execSync(`xcrun devicectl device install app --device ${udid} "${appPath}"`, {
      stdio: 'inherit',
      timeout: 300000
    })
    console.log('✅ App installed via devicectl')
  } catch {
    console.log('⚠️  devicectl failed, trying ios-deploy...')
    execSync(`ios-deploy -i ${udid} -b "${appPath}"`, {
      stdio: 'inherit',
      timeout: 300000
    })
    console.log('✅ App installed via ios-deploy')
  }
}

/**
 * Launch an app on an iOS device by bundle ID.
 * macOS only. Tries xcrun devicectl first, falls back to ios-deploy.
 */
export function launchIosApp(udid: string, bundleId: string, _appPath?: string): void {
  requireMacOS('iOS app launch')

  console.log(`🚀 Launching ${bundleId} on ${udid}...`)

  try {
    execSync(`xcrun devicectl device process launch --device ${udid} ${bundleId} 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000
    })
    console.log('✅ App launched via devicectl')
  } catch (err: any) {
    const output = err.stdout || err.stderr?.toString?.() || err.message || ''
    console.error(output)
    if (
      output.includes('trusted by the user') ||
      output.includes('Security') ||
      output.includes('invalid code signature')
    ) {
      console.error(
        '\n❌ Launch failed: the app needs to be trusted on the device.\n' +
          '   On your iPhone: Settings > General > VPN & Device Management\n' +
          '   Find the developer profile and tap "Trust".\n\n' +
          '   Then re-run with --skip-build to install and launch without rebuilding.\n'
      )
      process.exit(1)
    }
    throw err
  }
}
