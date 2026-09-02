// Minimal ambient surface for `test-tmp`. The package ships no types; it exposes
// a single async factory that creates a unique temporary directory for a test
// run and resolves to its path.
declare module 'test-tmp' {
  export default function createTmpDir(options?: Record<string, unknown>): Promise<string>
}
