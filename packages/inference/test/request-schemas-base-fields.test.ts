import test from 'brittle'
import type { z } from 'zod'
import { requestSchema } from '@/schemas/common'
import { trackedRequestSchema, UNTRACKED_REQUEST_TYPES } from '@/schemas/request-base'

// Every request the engine accepts carries the caller session, and every
// request that registers cancellable work carries the caller's request id.
// This walks the request union so a method added without the base schema
// fails here rather than silently running as the owner session.

type AnySchema = z.ZodType & {
  def: {
    type: string
    options?: AnySchema[]
    in?: AnySchema
    innerType?: AnySchema
    getter?: () => AnySchema
    left?: AnySchema
    right?: AnySchema
    values?: unknown[]
  }
  shape?: Record<string, AnySchema>
}

/** Every object schema a request can be parsed as. */
function leafObjects(schema: AnySchema): AnySchema[] {
  const { def } = schema
  switch (def.type) {
    case 'object':
      return [schema]
    case 'union':
      return (def.options ?? []).flatMap(leafObjects)
    case 'pipe':
      return leafObjects(def.in!)
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
      return leafObjects(def.innerType!)
    case 'lazy':
      return leafObjects(def.getter!())
    case 'intersection':
      // Both sides contribute fields; a union on either side multiplies out.
      return leafObjects(def.left!).flatMap((left) =>
        leafObjects(def.right!).map(
          (right) =>
            ({
              def: { type: 'object' },
              shape: { ...left.shape, ...right.shape }
            }) as AnySchema
        )
      )
    default:
      throw new Error(`unexpected schema node "${def.type}" inside requestSchema`)
  }
}

function requestType(leaf: AnySchema): string {
  const typeField = leaf.shape?.['type']
  const values = typeField ? leafObjectsOrSelf(typeField).flatMap((s) => s.def.values ?? []) : []
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error(`request member without a single literal "type": ${JSON.stringify(values)}`)
  }
  return values[0]
}

function leafObjectsOrSelf(schema: AnySchema): AnySchema[] {
  try {
    return leafObjects(schema)
  } catch {
    return [schema]
  }
}

test('every request schema carries the caller session', (t) => {
  const leaves = leafObjects(requestSchema as unknown as AnySchema)
  t.ok(leaves.length > 50, `walked ${leaves.length} request members`)
  for (const leaf of leaves) {
    const type = requestType(leaf)
    t.ok(leaf.shape?.['sessionId'], `${type} has sessionId`)
  }
})

// The engine assigns a request id to every request type outside
// `UNTRACKED_REQUEST_TYPES` that arrives without one, so the two must agree.
test('every request that registers work carries a request id, and no other does', (t) => {
  const leaves = leafObjects(requestSchema as unknown as AnySchema)
  for (const leaf of leaves) {
    const type = requestType(leaf)
    // `cancel` names a target requestId of its own; only the base field counts.
    const tracked = leaf.shape?.['requestId'] === trackedRequestSchema.shape.requestId
    t.is(tracked, !UNTRACKED_REQUEST_TYPES.has(type), `${type} takes a requestId: ${tracked}`)
  }
})
