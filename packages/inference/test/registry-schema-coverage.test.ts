import test from 'brittle'
import { registry } from '../src/registry'
import { requestSchema } from '../src/schemas'

// `dispatch` validates every request against `requestSchema` before running a
// handler, so a registered request type with no matching schema is rejected at
// runtime. This asserts the wiring statically: every key in the registry must
// be an accepted `type` in the request-schema union. Adding an operation to the
// registry without its schema fails here rather than silently skipping
// validation + defaulting.
//
// Detection is by parse behavior, not schema introspection, so it holds
// regardless of how a member schema is built (plain object, union, refinement).
// For an unknown type every union branch errors on the `type` field; for a
// known type at least one branch accepts the literal and errors only elsewhere.
function requestTypeIsWired(type: string): boolean {
  const result = requestSchema.safeParse({ type })
  if (result.success) return true
  for (const issue of result.error.issues) {
    if (issue.code !== 'invalid_union') continue
    const branches = (issue as unknown as { errors: { path: unknown[] }[][] }).errors
    for (const branch of branches) {
      const rejectsTheType = branch.some((e) => e.path[0] === 'type')
      if (!rejectsTheType) return true
    }
  }
  return false
}

test('every registered request type has a schema in the request-schema union', (t) => {
  for (const type of Object.keys(registry)) {
    t.ok(
      requestTypeIsWired(type),
      `registry type "${type}" must have a matching request schema — dispatch validates against it`
    )
  }
})
