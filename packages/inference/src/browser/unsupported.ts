export type Unsupported = {
  (...args: never[]): never
  new (...args: never[]): never
  readonly [key: string]: Unsupported
}

export function unsupported(name: string): Unsupported {
  const fail = (..._args: never[]): never => {
    throw new Error(`${name} is not available in the browser`)
  }
  let stub: Unsupported
  const handler: ProxyHandler<Unsupported> = {
    get: (_target, property) =>
      property === 'then' ? undefined : property === Symbol.toPrimitive ? () => name : stub,
    apply: fail,
    construct: fail
  }
  stub = new Proxy(function () {} as Unsupported, handler)
  return stub
}
