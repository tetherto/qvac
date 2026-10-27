// What an extension elsewhere may import, resolved here; nothing loads until it is imported.
const NAMES = {
  fs: 'bare-fs',
  os: 'bare-os',
  crypto: 'bare-crypto',
  process: 'bare-process',
  url: 'bare-url',
  path: 'bare-path',
  events: 'bare-events',
  '@qvac/harness': '@qvac/harness',
  '@qvac/harness/plugins': '@qvac/harness/plugins',
  '@qvac/harness/plugins/context': '@qvac/harness/plugins/context',
  '@qvac/harness/race-abort': '@qvac/harness/race-abort',
  '@qvac/sdk': '@qvac/inference'
}

// names, not literals: Bare links each literal import.meta.resolve() when it loads
export function extensionImports(resolve = (name: string) => import.meta.resolve(name)) {
  return Object.fromEntries(Object.entries(NAMES).map(([name, target]) => [name, resolve(target)]))
}
