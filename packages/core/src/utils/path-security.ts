import path from 'bare-path'
import { PathTraversalError } from '../errors'

/**
 * Sanitize a path component that will be joined to a base directory.
 * Strips traversal sequences, absolute prefixes, and normalizes separators.
 *
 * Throws on null bytes (literal or URL-encoded).
 */
export function sanitizePathComponent(component: string): string {
  if (component === '') return ''

  // Reject null bytes (literal and URL-encoded)
  if (component.includes('\0') || component.includes('%00')) {
    throw new Error(`Path component contains null byte: ${component}`)
  }

  let sanitized = component

  // Decode common URL-encoded traversal sequences
  sanitized = sanitized.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\')

  // Normalize backslashes to forward slashes
  sanitized = sanitized.replace(/\\/g, '/')

  // Strip Windows drive letter prefixes (C:/, D:/, etc.)
  sanitized = sanitized.replace(/^[A-Za-z]:\//, '')

  // Strip leading slashes (absolute path prefixes)
  sanitized = sanitized.replace(/^\/+/, '')

  // Remove all ".." segments (start, middle, end) iteratively until stable
  let prev = ''
  while (prev !== sanitized) {
    prev = sanitized
    sanitized = sanitized.replace(/^\.\.\//g, '')
    sanitized = sanitized.replace(/\/\.\.$/g, '')
    sanitized = sanitized.replace(/\/\.\.\//g, '/')
    if (sanitized === '..') sanitized = ''
  }

  // Strip any remaining leading slashes produced by stripping
  sanitized = sanitized.replace(/^\/+/, '')

  return sanitized
}

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
