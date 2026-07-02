// Runtime globals Bare exposes that no package types cover. `process` is
// optional: a Bare app may install `bare-process` and set `globalThis.process`,
// but core never requires it — `profiling/clock.ts` only reads `process.hrtime`
// behind a `typeof` guard.
declare global {
  function setImmediate<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void,
    ...args: TArgs
  ): unknown
  function clearImmediate(handle: unknown): void

  const process:
    | {
        hrtime?: {
          (): [number, number]
          bigint?: () => bigint
        }
      }
    | undefined
}

export {}
