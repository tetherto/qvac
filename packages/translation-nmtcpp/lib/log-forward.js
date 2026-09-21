"use strict";
/**
 * Native-free forwarding of C++ log messages onto a JS logger object.
 *
 * Lives in its own module (rather than inline in `marian.ts`) so it can be
 * unit-tested without loading the native binding — `marian.ts` eagerly
 * `require`s `./binding`, which is unavailable in the unit-test environment.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_LEVELS = void 0;
exports.forwardTransitionLog = forwardTransitionLog;
/**
 * Maps the C++ Priority enum onto logger method names.
 * Priority: ERROR=0, WARNING=1, INFO=2, DEBUG=3.
 */
exports.LOG_LEVELS = ["error", "warn", "info", "debug"];
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
function forwardTransitionLog(transitionCb, priority, message) {
    const level = exports.LOG_LEVELS[priority] || "info";
    if (typeof transitionCb[level] === "function") {
        transitionCb[level](message);
    }
}
