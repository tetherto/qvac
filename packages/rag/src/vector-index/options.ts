import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { fromZodError } from '../validation.js'
import { DEFAULT_SNAPSHOT_EVERY, type IndexConfig } from './registry.js'
import type { IndexProvider, IndexStorage, SnapshotFileSystem } from '../types.js'

// TurboVec's rotation works on blocks of 8 and is capped at 1,024 dimensions.
const TURBOVEC_MAX_DIMENSIONS = 1024

function hasMethods<T>(names: string[], message: string) {
  return z.custom<T>((value) => {
    const record = value as Record<string, unknown> | null
    return (
      typeof record === 'object' &&
      record !== null &&
      names.every((name) => typeof record[name] === 'function')
    )
  }, message)
}

const indexOptionsSchema = z
  .object({
    dir: z.string().min(1).optional(),
    snapshotEvery: z.number().int().positive().optional(),
    provider: hasMethods<IndexProvider>(['create'], 'provider needs a create function').optional(),
    fs: hasMethods<SnapshotFileSystem>(
      ['mkdir', 'readFile', 'writeFile', 'rename', 'unlink'],
      'fs needs mkdir, readFile, writeFile, rename and unlink'
    ).optional()
  })
  .strict()

const namespaceIndexSchema = z
  .object({
    storage: z.enum(['f32', 'q8', 'turbovec-q4', 'turbovec-q2']).optional()
  })
  .strict()

export function parseIndexOptions(options: unknown): IndexConfig {
  const parsed = indexOptionsSchema.optional().safeParse(options)
  if (!parsed.success) throw fromZodError(ERR_CODES.INVALID_INPUT, parsed.error, 'index')
  return {
    dir: parsed.data?.dir,
    snapshotEvery: parsed.data?.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY,
    provider: parsed.data?.provider,
    fs: parsed.data?.fs
  }
}

export function parseIndexStorage(index: unknown, dimensions: number): IndexStorage | undefined {
  const parsed = namespaceIndexSchema.optional().safeParse(index)
  if (!parsed.success) throw fromZodError(ERR_CODES.INVALID_INPUT, parsed.error, 'index')
  const storage = parsed.data?.storage
  if (
    storage?.startsWith('turbovec-') &&
    (dimensions % 8 !== 0 || dimensions > TURBOVEC_MAX_DIMENSIONS)
  ) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `'${storage}' storage needs dimensions divisible by 8 and at most ${TURBOVEC_MAX_DIMENSIONS}, got ${dimensions}`
    })
  }
  return storage
}
