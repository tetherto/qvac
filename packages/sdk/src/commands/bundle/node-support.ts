import { versions } from 'node:process'
import semver from 'semver'
import { BarePackNodeUnsupportedError } from '@/utils/errors-client'

// bare-module-lexer (loaded by bare-stow through bare-module-traverse) calls
// js_is_sharedarraybuffer from its native addon, which Node outside this range
// lacks; the bundling process crashes instead of throwing. Same range as
// engines.node in @qvac/cli.
export const BARE_PACK_NODE_ENGINES = '^22.21.0 || >=24.9.0'

export function isBarePackNodeSupported(version: string): boolean {
  return semver.satisfies(version, BARE_PACK_NODE_ENGINES, { includePrerelease: true })
}

export interface NodeVersions {
  node: string
  bun?: string | undefined
}

/**
 * Bundling runs the lexer in this process, so `versions.node` is the Node that
 * loads it. Bun loads it too but reports an emulated Node version, so it is
 * not checked.
 */
export function assertNodeCanBundle(nodeVersions: NodeVersions = versions): void {
  if (nodeVersions.bun !== undefined) return
  if (isBarePackNodeSupported(nodeVersions.node)) return
  throw new BarePackNodeUnsupportedError(nodeVersions.node, BARE_PACK_NODE_ENGINES)
}
