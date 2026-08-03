import { platform } from 'bare-os'

const platformDefinitions: Record<string, string> = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 */
function getApiDefinition(): string {
  return platformDefinitions[platform()] ?? 'vulkan'
}

export = getApiDefinition
