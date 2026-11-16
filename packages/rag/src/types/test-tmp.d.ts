// Minimal ambient surface for `test-tmp`. The package ships no types; it exposes
// a single async factory that creates a unique temporary directory, removed in
// teardown when given the brittle test.
declare module 'test-tmp' {
  export default function createTmpDir(t?: unknown): Promise<string>
}
