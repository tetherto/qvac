import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from './errors.js'
import type { SearchScope } from './types.js'

const documentIdsSchema = z.array(z.string().min(1))

const scopeSchema = z
  .object({
    namespace: z.string().min(1),
    documentIds: documentIdsSchema.optional()
  })
  .strict()

const narrowingSchema = z
  .object({
    namespace: z.string().min(1).optional(),
    documentIds: documentIdsSchema.optional()
  })
  .strict()

function invalidScope(error: z.ZodError): QvacErrorRAG {
  const reason = error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ')
  return new QvacErrorRAG({ code: ERR_CODES.INVALID_SCOPE, adds: reason })
}

// Rejects a missing namespace and unknown keys, so a typo never widens a search.
export function parseScope(scope: unknown): SearchScope {
  const parsed = scopeSchema.safeParse(scope)
  if (!parsed.success) throw invalidScope(parsed.error)
  return normalize(parsed.data)
}

export function intersectScope(bound: SearchScope, request: unknown): SearchScope {
  if (request === undefined) return bound
  const parsed = narrowingSchema.safeParse(request)
  if (!parsed.success) throw invalidScope(parsed.error)
  const narrowing = parsed.data

  if (narrowing.namespace !== undefined && narrowing.namespace !== bound.namespace) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_SCOPE,
      adds: `namespace '${narrowing.namespace}' is outside the bound namespace '${bound.namespace}'`
    })
  }
  if (narrowing.documentIds === undefined) return bound
  if (bound.documentIds === undefined) {
    return normalize({ namespace: bound.namespace, documentIds: narrowing.documentIds })
  }
  const allowed = new Set(bound.documentIds)
  return {
    namespace: bound.namespace,
    documentIds: unique(narrowing.documentIds).filter((id) => allowed.has(id))
  }
}

function normalize(scope: SearchScope): SearchScope {
  if (scope.documentIds === undefined) return { namespace: scope.namespace }
  return { namespace: scope.namespace, documentIds: unique(scope.documentIds) }
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids))
}
