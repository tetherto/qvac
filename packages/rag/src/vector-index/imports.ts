// The dynamic imports `ready()` runs. Tests replace them to simulate a host
// that refuses module loading after startup.
export const importers = {
  turbovec: (): Promise<unknown> => import('@qvac/turbovec-ggml'),
  fs: (): Promise<unknown> => import('#fs')
}
