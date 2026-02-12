/**
 * Pure string sanitization for path components. No runtime-specific dependencies.
 * Safe to import from both Bare (server) and Bun/Node (tests, client).
 */

/**
 * Sanitize a path component that will be joined to a base directory.
 *
 * STUB: returns input unchanged. Traversal protection not yet implemented.
 */
export function sanitizePathComponent(component: string): string {
  return component;
}

/**
 * Check whether a resolved target path is contained within a base directory.
 * Portable — caller provides the resolve function and separator for their runtime.
 *
 * STUB: always returns true. Boundary checking not yet implemented.
 */
export function checkPathWithinBase(
  basePath: string,
  targetPath: string,
  resolveFn: (...args: string[]) => string,
  sep: string,
): boolean {
  // STUB: always returns true. Boundary checking not yet implemented.
  void basePath; void targetPath; void resolveFn; void sep;
  return true;
}
