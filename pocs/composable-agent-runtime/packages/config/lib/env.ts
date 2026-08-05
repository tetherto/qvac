const runtimeProcess = Reflect.get(globalThis, 'process')
const env =
  typeof runtimeProcess === 'object' && runtimeProcess !== null
    ? Reflect.get(runtimeProcess, 'env')
    : undefined

export default isEnvironment(env) ? env : {}

function isEnvironment(
  value: unknown
): value is Readonly<Record<string, string | undefined>> {
  return typeof value === 'object' && value !== null
}
