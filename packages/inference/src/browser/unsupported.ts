// Placeholder for a native-only module in the browser build. Importing it is
// harmless; calling or constructing anything from it throws a clear error.
export function unsupported(name: string): any {
  const fail = (): never => {
    throw new Error(`${name} is not available in the browser`)
  }
  const handler: ProxyHandler<() => void> = {
    // `then` stays undefined so a placeholder is never mistaken for a promise.
    get: (_target, property) =>
      property === 'then' ? undefined : property === Symbol.toPrimitive ? () => name : stub,
    apply: fail,
    construct: fail
  }
  const stub: any = new Proxy(function unavailable() {}, handler)
  return stub
}
