import test from 'brittle'
import { registry } from '@/registry'
import { requestSchema } from '@/schemas'

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

/**
 * Every literal `type` reachable from the request-schema union. Branches vary:
 * plain objects, objects wrapped by `.superRefine(...)`, nested unions and
 * discriminated unions, and one intersection — so this walks all of them.
 */
function requestSchemaTypes(): string[] {
  const found = new Set<string>()
  collectRequestTypes(requestSchema, found)
  if (found.size === 0) throw new Error('no request types could be read from the schema union')
  return [...found]
}

type SchemaNode = {
  shape?: Record<string, { value?: unknown }>
  options?: unknown[]
  in?: unknown
  _def?: { innerType?: unknown; options?: unknown[]; left?: unknown; right?: unknown }
}

function collectRequestTypes(node: unknown, found: Set<string>): void {
  let current = node as SchemaNode | undefined
  for (let hop = 0; current && !current.shape && !branchesOf(current) && hop < 6; hop++) {
    current = (current._def?.innerType ?? current.in) as SchemaNode | undefined
  }
  if (!current) return

  const branches = branchesOf(current)
  if (branches) {
    for (const branch of branches) collectRequestTypes(branch, found)
    return
  }

  const literal = current.shape?.['type']
  if (typeof literal?.value === 'string') found.add(literal.value)
}

/** Union options, discriminated-union options, or the two sides of an intersection. */
function branchesOf(node: SchemaNode): unknown[] | undefined {
  if (Array.isArray(node.options)) return node.options
  if (Array.isArray(node._def?.options)) return node._def.options
  const { left, right } = node._def ?? {}
  if (left && right) return [left, right]
  return undefined
}

// The mirror of the test above, and the one that matters for a new operation:
// `dispatch` resolves every request through `registry[type]` and throws
// `RPCNoHandlerError` when the key is missing. A schema and a plugin handler
// alone are not enough to make an operation callable, and nothing else fails
// when the registry entry is forgotten — the request simply never routes.
test('every request schema type has a handler in the registry', (t) => {
  const types = requestSchemaTypes()
  t.ok(types.includes('audioUnderstand'), 'the walker reaches plugin stream ops')
  for (const type of types) {
    t.ok(
      type in registry,
      `request schema "${type}" must have a registry entry — dispatch routes through it`
    )
  }
})
