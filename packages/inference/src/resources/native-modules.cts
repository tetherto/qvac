// Loads the native collector addons synchronously, each on its own so one that
// fails to load cannot disable the other collector. This is CommonJS because an
// ES module can only load them independently with `await import()` at the top
// level, and a graph holding a top-level await doesn't evaluate synchronously
// when the worker entry is loaded with `require()`.
declare const require: (specifier: string) => unknown

export type NativeModule<T> = { status: 'fulfilled'; value: T } | { status: 'rejected' }

function load<T>(loader: () => unknown): NativeModule<T> {
  try {
    return { status: 'fulfilled', value: loader() as T }
  } catch {
    return { status: 'rejected' }
  }
}

export const cpuModule = load<typeof import('bare-cpu-info')>(() => require('bare-cpu-info'))
export const gpuModule = load<typeof import('bare-gpu-info').default>(() =>
  require('bare-gpu-info')
)
