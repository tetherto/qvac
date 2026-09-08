export function toForgePlatform(platform: string | undefined): NodeJS.Platform {
  if (!platform) return process.platform
  if (platform === 'macos') return 'darwin'
  if (platform === 'windows') return 'win32'
  if (platform === 'linux') return 'linux'
  if (platform === 'darwin' || platform === 'win32') return platform
  throw new Error(`Unsupported Electron platform: ${platform}`)
}
