// Runtime globals Bare exposes that no package types cover.
declare global {
  function setImmediate<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void,
    ...args: TArgs
  ): unknown
  function clearImmediate(handle: unknown): void
}

export {}
