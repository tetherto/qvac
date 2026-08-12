import path from 'bare-path'
import { PathTraversalError } from '@/utils/errors-server'
import { sanitizePathComponent, isSafeCacheKey, checkPathWithinBase } from '@/utils/path-sanitize'

// Re-export the bare-free helpers unchanged
export { sanitizePathComponent, isSafeCacheKey } from '@/utils/path-sanitize'

/**
 * Check whether a target path is contained within a base directory.
 * Both paths are resolved to absolute before comparison.
 */
export function isPathWithinBase(basePath: string, targetPath: string): boolean {
  return checkPathWithinBase(
    basePath,
    targetPath,
    (...args: [string, ...string[]]) => path.resolve(...args),
    path.sep || '/'
  )
}

/** Throws PathTraversalError unless `cacheKey` is a safe single component. */
export function assertSafeCacheKey(cacheKey: string, basePath: string): void {
  if (!isSafeCacheKey(cacheKey)) {
    throw new PathTraversalError(cacheKey, basePath)
  }
}

/**
 * Sanitize components, join them to a base path, and verify the result
 * stays within the base directory. Throws PathTraversalError on escape.
 */
export function validateAndJoinPath(basePath: string, ...components: string[]): string {
  const sanitized = components.map((c) => sanitizePathComponent(c))
  const joined = path.join(basePath, ...sanitized)
  const resolved = path.resolve(joined)

  if (!isPathWithinBase(basePath, resolved)) {
    throw new PathTraversalError(components.join('/'), basePath)
  }

  return resolved
}
