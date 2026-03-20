import type { Node } from 'fumadocs-core/page-tree';
import { tree as latestTree, findFolderChildren } from './latest';
import { source } from '@/lib/source';

export const tree: Node[] = latestTree.map(node =>
  node.type === 'folder' && node.name === 'JS API'
    ? {
        ...node,
        index: node.index ? { ...node.index, url: '/dev/sdk/api' } : node.index,
        children: findFolderChildren(source.pageTree.children, '/dev/sdk/api'),
      }
    : node
);
