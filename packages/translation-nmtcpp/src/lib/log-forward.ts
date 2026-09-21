/**
 * Native-free forwarding of C++ log messages onto a JS logger object.
 *
 * Lives in its own module (rather than inline in `marian.ts`) so it can be
 * unit-tested without loading the native binding — `marian.ts` eagerly
 * `require`s `./binding`, which is unavailable in the unit-test environment.
 */

/** Optional logger sink used to bridge native C++ log messages into JS. */
export interface TranslationLogger {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/**
 * Maps the C++ Priority enum onto logger method names.
 * Priority: ERROR=0, WARNING=1, INFO=2, DEBUG=3.
 */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

/**
 * Forward one native log record to `transitionCb`.
 *
 * The call MUST stay method-style (`transitionCb[level](message)`) rather than
 * destructured into a bare function reference: QvacLogger's methods delegate to
 * `this._log`, so a detached call throws `TypeError: Cannot read properties of
 * undefined`. Regression guard for that crash lives in
 * `test/unit/log-forward.test.js`.
 *
 * @param transitionCb - logger sink; a missing/non-function method is a no-op
 * @param priority - C++ priority level; out-of-range falls back to `info`
 * @param message - the log line
 */
export function forwardTransitionLog(
  transitionCb: TranslationLogger,
  priority: number,
  message: string,
): void {
  const level = LOG_LEVELS[priority] || "info";
  if (typeof transitionCb[level] === "function") {
    transitionCb[level](message);
  }
}
