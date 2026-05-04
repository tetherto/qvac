import { DEFAULT_HOSTS } from '../../bundle-sdk/constants.js'
import type { Check } from '../check.js'

// Deploy targets — the full matrix of platforms the SDK can deploy to,
// which is a superset of CLI hosts (adds Android + iOS via BareKit).
// Informational by default: bare-pack ships prebuilts for every target,
// so bundling is always available. What's checked here is the host
// toolchain needed to *deploy* to each target class.

function desktopTargetsLine (hostPlatform: NodeJS.Platform, hostArch: string): string {
  const nativeHost = `${hostPlatform}-${hostArch}`
  const desktops = DEFAULT_HOSTS.filter((h) => !h.startsWith('android') && !h.startsWith('ios'))
  return desktops.map((h) => (h === nativeHost ? `${h} (native)` : h)).join(', ')
}

export const checkDesktopTargets: Check = (ctx) => {
  return {
    id: 'target-desktop',
    label: 'Desktop',
    status: 'pass',
    severity: 'informational',
    value: desktopTargetsLine(ctx.platform, ctx.arch),
    hint: 'bare-pack ships prebuilts for every desktop target; cross-bundling is always available.'
  }
}

export const checkAndroidTarget: Check = (ctx) => {
  const r = ctx.probe('adb', ['--version'])
  if (!r.ok) {
    return {
      id: 'target-android',
      label: 'Android (android-arm64)',
      status: 'warn',
      severity: 'recommended',
      value: 'adb not found',
      hint: 'Install Android platform tools to deploy QVAC apps to Android devices: https://developer.android.com/tools/releases/platform-tools'
    }
  }
  return {
    id: 'target-android',
    label: 'Android (android-arm64)',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'adb installed'
  }
}

export const checkIosTarget: Check = (ctx) => {
  if (ctx.platform !== 'darwin') {
    return {
      id: 'target-ios',
      label: 'iOS (ios-arm64 + simulators)',
      status: 'info',
      severity: 'informational',
      value: 'requires macOS host',
      hint: 'iOS apps can only be built/deployed from a macOS host with Xcode installed.'
    }
  }
  const r = ctx.probe('xcodebuild', ['-version'])
  if (!r.ok) {
    return {
      id: 'target-ios',
      label: 'iOS (ios-arm64 + simulators)',
      status: 'warn',
      severity: 'recommended',
      value: 'Xcode not found',
      hint: 'Install Xcode from the App Store (Command Line Tools alone are not sufficient for iOS builds).'
    }
  }
  return {
    id: 'target-ios',
    label: 'iOS (ios-arm64 + simulators)',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'Xcode installed'
  }
}
