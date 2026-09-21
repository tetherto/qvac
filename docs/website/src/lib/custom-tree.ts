import type { Node, Root } from 'fumadocs-core/page-tree';
import {
  computeSectionVersionUrl,
  documentedSoftwareOfKind,
  getCurrentLine,
  getDocumentedSoftware,
  versionOfFolder,
  type DocumentedVersion,
} from '@/lib/versions';
import { resolveIcon } from '@/lib/resolveIcon';

/**
 * Each top-level node of the composed tree is a collection, declared as a
 * folder with `root: true`. That flag is what makes Fumadocs treat it as a
 * Layout Tab and scope the sidebar to it: the framework matches the pathname
 * against the tree, takes the last root folder on that path as the active
 * root, and renders only that root's children.
 *
 * A collection's `index` is where its tab lands. It is not rendered as a
 * sidebar entry, so every collection also carries an explicit overview page
 * among its children — otherwise the overview would be reachable from the
 * tab but not from the sidebar.
 *
 * Every URL is collection-scoped, matching where the page lives under
 * `content/docs/<collection>`. The framework resolves the active collection by
 * matching the pathname against the tree, so these prefixes are what makes a
 * page activate its own tab.
 *
 * Navigation is declared in two dialects, by collection:
 *
 *   - An unversioned collection is declared here, by hand, as the `children`
 *     of its descriptor below.
 *   - A versioned collection declares nothing here. Each of its documentation
 *     lines carries its own `meta.json` files under
 *     `content/docs/<collection>/<folder>/`, and one root folder per line is
 *     composed from them at build time. Two lines can therefore order, add, or
 *     drop entries independently, and cutting a line copies its navigation
 *     along with its pages — the folder is the whole of it.
 */

/**
 * The inventory's entries, derived from the manifest rather than declared.
 * Everything the sidebar needs is already there — the package's published
 * name and where it is documented — and a second list would be one more thing
 * to forget when a package is added.
 *
 * One entry per package, and none per version: a package's versions are moved
 * between with the switcher, the same control a versioned collection's lines
 * use, so the sidebar carries the inventory's shape and the switcher carries
 * the version. A package is entered at its index, never at a version, because
 * the inventory publishes no current line — its version-less path belongs to
 * the index, and every README is addressed by its own segment.
 */
function inventoryChildren(): Node[] {
  return documentedSoftwareOfKind('package').map((software) => ({
    type: 'page',
    name: software.package,
    url: software.path,
  }));
}

/** The inventory's place in the Platform navigation. */
const inventoryFolder: Node = {
  name: 'Software inventory',
  type: 'folder',
  icon: resolveIcon('Package'),
  index: {
    type: 'page',
    name: 'Software inventory',
    url: '/platform/inventory',
  },
  children: inventoryChildren(),
};

/**
 * A root folder per inventory version page, holding the Platform navigation.
 *
 * The sidebar beside a page is the last root folder on the path Fumadocs
 * finds by matching the pathname against the tree, page URL for page URL. A
 * page named nowhere in the tree matches nothing, and the sidebar falls back
 * to listing the roots themselves — the reader lands on a README and is shown
 * a list of collections. Since a version page is deliberately absent from the
 * inventory's entries, it is named here instead, as the index of a root of
 * its own, which the sidebar renders as the Platform tree it would have
 * rendered anyway. A root's index is not itself an entry, so naming it here
 * puts nothing back in the sidebar.
 *
 * The inventory folder is opened, because a folder opens itself only for a
 * page it lists and it lists no version. Left shut, a reader who followed a
 * package into a README would be shown a Platform tree with no sign of where
 * they had gone.
 */
function inventoryVersionRoots(): Node[] {
  return documentedSoftwareOfKind('package').flatMap((software) =>
    software.versions.map(
      (version): Node => ({
        type: 'folder',
        root: true,
        name: `${software.package} ${version.version}`,
        index: {
          type: 'page',
          name: software.package,
          // Slash-less, the form `searchPath` compares against: it normalizes
          // the pathname it is given but not the URL it reads off the node.
          // What the browser requests is Next's business, and it writes the
          // trailing slash back into every href it renders.
          url: `${software.path}/${version.version}`,
        },
        children: platformChildren.map((node) =>
          node === inventoryFolder ? { ...inventoryFolder, defaultOpen: true } : node,
        ),
      }),
    ),
  );
}

const platformChildren: Node[] = [
  {
    name: 'Overview',
    url: '/platform',
    type: 'page',
    icon: resolveIcon('House'),
  },
  {
    type: 'separator',
    name: 'About QVAC',
  },
  {
    name: 'How it works',
    url: '/platform/about/how-it-works',
    type: 'page',
    icon: resolveIcon('Cog'),
  },
  {
    name: 'Vision',
    type: 'folder',
    icon: resolveIcon('Telescope'),
    index: { type: 'page', name: 'Vision', url: '/platform/about/vision' },
    children: [
      {
        name: 'Public launch',
        url: '/platform/about/public-launch',
        type: 'page',
        icon: resolveIcon('Megaphone'),
      },
    ],
  },
  {
    type: 'separator',
    name: 'Inventory',
  },
  inventoryFolder,
  {
    name: 'Addons',
    type: 'folder',
    icon: resolveIcon('Blocks'),
    index: { type: 'page', name: 'Addons', url: '/platform/addons' },
    children: [
      { name: 'llm-llamacpp', url: '/platform/addons/llm-llamacpp', type: 'page' },
      { name: 'embed-llamacpp', url: '/platform/addons/embed-llamacpp', type: 'page' },
      { name: 'translation-nmtcpp', url: '/platform/addons/translation-nmtcpp', type: 'page' },
      { name: 'transcription-whispercpp', url: '/platform/addons/transcription-whispercpp', type: 'page' },
      { name: 'transcription-parakeet', url: '/platform/addons/transcription-parakeet', type: 'page' },
      { name: 'tts-ggml', url: '/platform/addons/tts-ggml', type: 'page' },
      { name: 'audiogen-ggml', url: '/platform/addons/audiogen-ggml', type: 'page' },
      { name: 'diffusion-cpp', url: '/platform/addons/diffusion-cpp', type: 'page' },
    ],
  },
];

/**
 * Resources indexes material about using QVAC that is not the reference
 * documentation itself: what is published outside this site, and how to
 * consume this site programmatically.
 */
const resourcesChildren: Node[] = [
  {
    name: 'Overview',
    url: '/resources',
    type: 'page',
    icon: resolveIcon('DoorOpen'),
  },
  {
    name: 'Corpus protocol',
    url: '/resources/corpus-protocol',
    type: 'page',
    icon: resolveIcon('Bot'),
  },
];

interface Collection {
  name: string;
  description: string;
  /** The collection's path, absolute and without a trailing slash. */
  path: `/${string}`;
  /**
   * The sidebar entries, for a collection that declares them here. Left out by
   * a versioned collection, whose lines declare their own in `meta.json`.
   */
  children?: Node[];
}

/**
 * The collections, in the order the collection bar lists them. One descriptor
 * feeds both the bar and the root folders that scope the sidebar, so the two
 * can never list different collections.
 */
const COLLECTIONS: Collection[] = [
  {
    name: 'Platform',
    description: 'What QVAC is and what ships with it',
    path: '/platform',
    children: platformChildren,
  },
  {
    name: 'SDK',
    description: 'Install, configure, and build with the SDK',
    path: '/sdk',
  },
  {
    name: 'Provider',
    description: 'Run and connect the model provider server',
    path: '/provider',
  },
  {
    name: 'Resources',
    description: 'Tutorials, how-tos, and sample projects',
    path: '/resources',
    children: resourcesChildren,
  },
];

/**
 * The children a documentation line declares, read out of the page tree
 * Fumadocs builds from `meta.json`. `folderPath` is relative to
 * `content/docs`, group parentheses included — `sdk/(v0.19)`.
 *
 * A folder's `$id` is that same path, which older Fumadocs prefixed with the
 * root's own id, so both shapes are accepted.
 *
 * Throws when the folder is absent, because the alternative is a collection
 * that renders an empty sidebar: the manifest names a line whose content was
 * never cut, and that should stop the build rather than ship.
 */
export function lineChildren(pageTree: Root, folderPath: string): Node[] {
  const ids = [folderPath, `${pageTree.$id}:${folderPath}`];

  function find(nodes: Node[]): Node[] | undefined {
    for (const node of nodes) {
      if (node.type !== 'folder') continue;
      if (typeof node.$id === 'string' && ids.includes(node.$id)) {
        return node.children;
      }
      const found = find(node.children);
      if (found) return found;
    }
  }

  const children = find(pageTree.children);
  if (!children) {
    throw new Error(
      `No content folder at content/docs/${folderPath}. The version manifest ` +
        `declares this line, so either cut it or drop its manifest entry.`,
    );
  }
  return children;
}

/**
 * Where a line is entered. The current line answers at the collection's own
 * path, written slash-less like every other entry declared here; an older line
 * answers at its version segment, which carries a dot and therefore needs the
 * trailing slash (see `computeSectionVersionUrl`).
 */
function lineIndexUrl(
  collection: Collection,
  line: DocumentedVersion,
  current: DocumentedVersion | null,
): string {
  const url = computeSectionVersionUrl(
    collection.path,
    versionOfFolder(line.folder),
    current ? versionOfFolder(current.folder) : null,
  );
  return url === `${collection.path}/` ? collection.path : url;
}

/**
 * The root folders a collection contributes: one for an unversioned
 * collection, and one per line for a versioned one. A line needs its own root
 * so that the sidebar beside a page shows that line and no other.
 */
function collectionRoots(collection: Collection, pageTree: Root): Node[] {
  const root = {
    name: collection.name,
    description: collection.description,
    type: 'folder' as const,
    root: true,
  };

  if (collection.children) {
    return [
      {
        ...root,
        index: { type: 'page', name: 'Overview', url: collection.path },
        children: collection.children,
      },
    ];
  }

  const software = getDocumentedSoftware(collection.path);
  if (!software) {
    throw new Error(
      `Collection ${collection.name} declares no children and no manifest ` +
        `entry, so nothing describes its navigation.`,
    );
  }

  const current = getCurrentLine(software);
  const folder = collection.path.slice(1);
  return software.versions.map((line): Node => ({
    ...root,
    index: {
      type: 'page',
      name: 'Overview',
      url: lineIndexUrl(collection, line, current),
    },
    children: lineChildren(pageTree, `${folder}/${line.folder}`),
  }));
}

/**
 * The navigation tree, composed from what this file declares and what the
 * documentation lines declare for themselves.
 *
 * A function, not a constant, because the derived half comes from
 * `source.pageTree` — which the caller holds, keeping this module free of the
 * content layer and testable without it.
 */
export function buildCustomTree(pageTree: Root): Node[] {
  return [
    ...COLLECTIONS.flatMap((collection) =>
      collectionRoots(collection, pageTree),
    ),
    ...inventoryVersionRoots(),
  ];
}

/**
 * The collection bar's entries — exactly one per collection, pointing at its
 * current line, however many lines that collection publishes.
 *
 * Passing them explicitly, rather than letting the layout derive them, is what
 * decides a page's collection by URL prefix: a derived tab carries the set of
 * URLs declared under its folder and marks itself active only for those, which
 * leaves any page absent from the tree belonging to no collection at all. A
 * tab without that set falls back to matching the pathname against its own
 * URL, which is what "the page lives under `/sdk`" means here — and it is what
 * keeps one tab active across every line of a versioned collection.
 */
export const collectionTabs = COLLECTIONS.map((collection) => ({
  url: collection.path,
  title: collection.name,
  description: collection.description,
}));
