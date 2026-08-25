// Environment access for the default (non-Bare) runtimes. On Bare the `#env`
// import resolves to `bare-env` instead (see the package `imports` map); Node
// and Expo fall back to `process.env`, or an empty object when no `process`
// global exists.
const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } }

const env: Record<string, string | undefined> = runtime.process?.env ?? {}

export default env
