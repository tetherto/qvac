/**
 * The platform label this client registers with. `skip.platforms` and the table's `configOn` match
 * by segment and widen over the OS only, so a leg that calls itself plain `desktop` matches no
 * per-OS rule.
 *
 * Derived here rather than imported: the catalog builds against the published `@qvac/test-suite`
 * range, and each client has always named its own label -- the Python one is `desktop-python`.
 */
function hostOs(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

/** `<family>-<os>`, the shape every leg of the skip matrix is keyed by. */
export function hostPlatform(family: string): string {
  return `${family}-${hostOs()}`
}
