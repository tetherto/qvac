/**
 * The platform label a JS consumer registers with. `skip.platforms` matches by segment and widens
 * over the OS only, so a leg that registers plain `desktop` matches no per-OS rule.
 */
export function hostOs(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

/** `<family>-<os>`, the shape every leg of the skip matrix is keyed by. */
export function hostPlatform(family: string): string {
  return `${family}-${hostOs()}`
}
