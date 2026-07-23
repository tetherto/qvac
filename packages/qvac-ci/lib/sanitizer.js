/**
 * Base sanitizer interface — passthrough by default.
 *
 * Subcommands that handle sensitive secrets should extend this class and
 * override redact() with their own SECRET_PATTERNS.
 * sanitizeError() is a template method; it calls this.redact() so overriding
 * redact() alone is sufficient.
 *
 * Example:
 *   class GitHubSanitizer extends Sanitizer {
 *     redact (str) { ... }
 *   }
 */
export class Sanitizer {
  redact (str) {
    return str
  }

  sanitizeError (err) {
    if (err && typeof err.message === 'string') {
      return this.redact(err.message)
    }
    return this.redact(String(err))
  }
}
