import type { z } from 'zod'

import { QvacErrorRAG } from './errors.js'

// Names the failing field in each issue; `prefix` scopes the path, e.g. `space`.
export function fromZodError(code: number, error: z.ZodError, prefix?: string): QvacErrorRAG {
  const reason = error.issues
    .map((issue) => {
      const path = [...(prefix ? [prefix] : []), ...issue.path.map(String)].join('.')
      return (path ? `${path}: ` : '') + issue.message
    })
    .join('; ')
  return new QvacErrorRAG({ code, adds: reason })
}
