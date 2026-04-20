import type { Node } from 'fumadocs-core/page-tree';
import { tree as latestTree } from './latest';
import { tree as devTree } from './dev';
import { tree as v070Tree } from './v0.7.0';
import { tree as v080Tree } from './v0.8.0';

/**
 * All sidebar trees keyed by version.
 * 'latest' is the unversioned (current) tree.
 * Versioned trees derive from latestTree and only swap the API section.
 */
export function getAllTrees(): Record<string, Node[]> {
  return {
    'dev': devTree,
    'v0.8.0': v080Tree,
    'v0.7.0': v070Tree,
    'latest': latestTree,
  };
}
