/**
 * The platform label a JS consumer registers with. `skip.platforms` matches by segment and widens
 * over the OS only, so a leg that registers plain `desktop` matches no per-OS rule.
 *
 * The host is a parameter so every mapping can be tested, not only the one this machine runs.
 */
export function hostOs(platform: string = process.platform): 'macos' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

/** `<family>-<os>`, the shape every leg of the skip matrix is keyed by. */
export function hostPlatform(family: string, platform: string = process.platform): string {
  return `${family}-${hostOs(platform)}`
}
