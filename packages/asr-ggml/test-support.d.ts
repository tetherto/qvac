/**
 * Low-level engine interfaces, exported for this package's own test suites.
 *
 * NOT part of the supported consumer API: applications and the SDK use the
 * ASRGgml class from the root export. This entrypoint exists because the mobile
 * test bundler resolves a test's imports against the package's exports, so a
 * bundled test cannot reach `engines/<engine>/<engine>.js` by relative path.
 * One clearly-labelled test-support path is preferred over reinstating the
 * per-engine subpath exports the parents had (`./parakeet.js` and friends),
 * which is the surface the unified package deliberately removed.
 */
export { WhisperInterface } from "./engines/whisper/whisper";
export { ParakeetInterface } from "./engines/parakeet/parakeet";
