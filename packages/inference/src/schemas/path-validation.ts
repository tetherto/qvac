import { z } from 'zod'
// Import from the dependency-free module: this schema is re-exported through
// the Node-safe `@qvac/inference/surface`, and `@/utils/path-security` pulls in
// `bare-path` at runtime.
import { sanitizePathComponent } from '@/utils/path-sanitize'

/**
 * Zod refinement for path components that get joined to a base directory.
 * Rejects strings containing traversal sequences (.., null bytes).
 *
 * DO NOT apply to fields that accept absolute user paths (e.g. audio, image,
 * model, or attachment paths).
 */
export const safePathComponent = z.string().refine(
  (s) => {
    // Reject literal traversal
    if (s.includes('..')) return false
    // Reject null bytes (literal and URL-encoded)
    if (s.includes('\0') || s.toLowerCase().includes('%00')) return false
    // Reject URL-encoded traversal (%2e = ".", %2f = "/", %5c = "\")
    if (/%2e/i.test(s)) return false
    // Reject components that resolve to the directory they are joined against.
    const sanitized = sanitizePathComponent(s)
    return sanitized.split('/').some((segment) => segment !== '' && segment !== '.')
  },
  {
    message:
      "Path component must name a child path and not contain traversal sequences ('..', '%2e'), null bytes, or '%00'"
  }
)
