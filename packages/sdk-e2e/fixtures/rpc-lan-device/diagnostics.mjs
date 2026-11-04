export function describeError(error, depth = 0, budget = { remaining: 8 }) {
  if (--budget.remaining < 0) return 'Error details truncated'
  if (!(error instanceof Error)) return String(error).slice(0, 512)
  return {
    name: error.name.slice(0, 128),
    message: error.message.slice(0, 512),
    ...('code' in error &&
      (typeof error.code === 'string' || typeof error.code === 'number') && {
        code: typeof error.code === 'string' ? error.code.slice(0, 64) : error.code
      }),
    ...(error.cause !== undefined &&
      depth < 5 && { cause: describeError(error.cause, depth + 1, budget) }),
    ...(error instanceof AggregateError &&
      depth < 5 && {
        errors: error.errors.slice(0, 3).map((cause) => describeError(cause, depth + 1, budget))
      })
  }
}
