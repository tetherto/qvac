import type { Node } from 'fumadocs-core/page-tree';
import { tree as latestTree } from './latest';
import { tree as v070Tree } from './v0.7.0';

/**
 * All sidebar trees keyed by version.
 * 'latest' is the unversioned (current) tree.
 * Versioned trees are only created for OLD versions (not the current latest).
 * Called server-side from the layout to avoid pulling source.ts into the client bundle.
 */
export function getAllTrees(): Record<string, Node[]> {
  return {
    'v0.7.0': v070Tree,
    'latest': latestTree,
  };
}
