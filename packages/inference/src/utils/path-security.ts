import path from 'bare-path'
import { PathTraversalError } from '@/errors/index'
import { sanitizePathComponent } from '@/utils/path-sanitize'

/**
 * Check whether a resolved target path is contained within a base directory.
 * Portable — caller provides the resolve function and separator for their runtime.
 */
export function checkPathWithinBase(
  basePath: string,
  targetPath: string,
  resolveFn: (...args: string[]) => string,
  sep: string
): boolean {
  const resolvedBase = resolveFn(basePath)
  const resolvedTarget = resolveFn(targetPath)

  if (resolvedTarget === resolvedBase) return true
  return resolvedTarget.startsWith(resolvedBase + sep)
}

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
