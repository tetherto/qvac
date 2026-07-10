import { z } from 'zod'
import { constantsRegistry, scalarConstantsRegistry } from '@/schemas/constants-registry'

type ConstantEntry =
  | { kind: 'enum'; members: Record<string, string | number> }
  | { kind: 'scalar'; value: string | number | boolean }

/**
 * JSON export of every registered public constant (`@/schemas/constants-
 * registry`) — named enums like `ModelType`/`ToolsMode`/`Verbosity`/
 * `PluginId`/`SupportedAudioFormat`, plus standalone scalars like
 * `VlaDefaultImageSize`. Generic over the constant's shape: it reads
 * whatever `z.enum(...)`/`z.literal(...)` schema was registered rather than
 * special-casing each constant, so a new registry entry needs no exporter
 * changes — only a schema + a registry line.
 */
export function buildConstantsRegistry(): Record<string, ConstantEntry> {
  const result: Record<string, ConstantEntry> = {}

  for (const [name, schema] of Object.entries(constantsRegistry)) {
    if (!(schema instanceof z.ZodEnum)) {
      throw new Error(`constantsRegistry.${name} must be a z.enum(...) schema`)
    }
    result[name] = { kind: 'enum', members: schema.enum }
  }

  for (const [name, schema] of Object.entries(scalarConstantsRegistry)) {
    if (!(schema instanceof z.ZodLiteral)) {
      throw new Error(`scalarConstantsRegistry.${name} must be a z.literal(...) schema`)
    }
    result[name] = { kind: 'scalar', value: schema.value }
  }

  return result
}
