/**
 * The platform label a JS consumer registers with.
 *
 * A definition's `skip.platforms` is matched by segment, and a coarse entry widens over the OS
 * only: `desktop` covers `desktop-linux`, while `desktop-linux` covers nothing but itself. A
 * consumer that registers as plain `desktop` therefore matches no per-OS rule at all, and a
 * policy written as "Core ML runs on macOS and iOS only" quietly runs everywhere. Snap and the
 * mobile consumers have always carried their OS; these two now do too.
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
