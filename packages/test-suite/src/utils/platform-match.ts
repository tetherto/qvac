import type { TestDefinition } from '../types/test-definition.js'

const OPERATING_SYSTEMS = new Set(['macos', 'linux', 'windows', 'ios', 'android'])

/**
 * Whether any `declared` platform entry covers `platform`. Matching is by segment prefix, so
 * `desktop` matches `desktop-macos` but never `desktop-pythonista`. A coarse entry widens over the
 * OS and nothing else: `electron` covers `electron-linux`, but `desktop` must not silently cover
 * `desktop-python`, which is a different client.
 */
export function matchesPlatform(platform: string, declared: readonly string[]): boolean {
  const segments = platform.split('-')
  return declared.some((entry) => {
    if (entry === platform) return true
    const entrySegments = entry.split('-')
    if (entrySegments.length >= segments.length) return false
    if (!entrySegments.every((segment, index) => segment === segments[index])) return false
    return segments.slice(entrySegments.length).every((segment) => OPERATING_SYSTEMS.has(segment))
  })
}

/**
 * Whether platform policy skips this test on `platform`, and why. When the skip carries
 * per-platform `reasons`, only the groups that match this platform are reported, so a leg does
 * not show the reasons another leg was skipped for.
 */
export function getPlatformSkipReason(
  definition: Pick<TestDefinition, 'skip'>,
  platform: string
): string | null {
  const skip = definition.skip
  if (!skip?.platforms?.length || !matchesPlatform(platform, skip.platforms)) return null

  const own = (skip.reasons ?? [])
    .filter((group) => matchesPlatform(platform, group.platforms))
    .map((group) => group.reason)
  return own.length > 0 ? own.join(' | ') : skip.reason
}
