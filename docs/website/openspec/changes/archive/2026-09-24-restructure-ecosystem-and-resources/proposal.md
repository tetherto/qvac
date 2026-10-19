## Why

Ecosystem is the collection a reader lands on, and it currently opens onto two entries — the Software Inventory and the add-on catalogue — neither of which is what QVAC is. A reader who arrives wanting to know what the project publishes is shown a package list and an add-on list, and nothing points at the SDK, the CLI, the assistant app, the platform, or the research. The collection is named after everything QVAC publishes but navigates to a fraction of it.

Resources has the opposite problem: it holds one page and an overview that describes a scope the collection does not have. The tutorials and the help material that belong to no single release are meanwhile trapped inside the SDK's documentation lines, copied into every line and versioned as though an Electron tutorial expired with a patch.

## What Changes

- Ecosystem's sidebar becomes a map of what QVAC publishes, grouped under three separators — Products, Platform, and Research — with the overview and the project's vision above them. Entries that lead out of the collection, to another collection or to the main website, become possible for the first time.
- The Products group reaches the SDK and CLI collections, the model-provider page inside the CLI, and the assistant app on its own site. The Platform group reaches Fabric on the main website, the add-on catalogue, and the Software Inventory. The Research group reaches the Psy model family and the Genesis datasets on the main website.
- Tutorials and Help leave the SDK collection and move to Resources, out of the documentation lines entirely. They stop being copied into each line and stop carrying a version they never varied by. **BREAKING** for the line-scoped addresses `/sdk/v0.18/tutorials/**`, `/sdk/v0.19/tutorials/**`, and their troubleshooting counterparts, which the site has never served outside this branch.
- Resources' overview is rewritten for the scope it actually gets, and its card for the main website is replaced by one for the Recipes section.
- The Corpus protocol page is renamed Build with AI, in its sidebar label, its page title, and its URL. Its former address is retired rather than redirected, because only this branch ever carried it.

## Capabilities

### New Capabilities

None. The change reshapes navigation and collection composition, both of which are already specified.

### Modified Capabilities

- `collection-navigation`: a collection's sidebar may carry entries that lead out of it — to another collection, or off the site — which today's scoping requirement forbids and today's validation gate would reject. The shape of the two hand-declared sidebars becomes specified rather than incidental.
- `docs-collections`: Ecosystem's composition gains the outward map; Resources gains the tutorials and the help material and loses the page name it never published under; the SDK gives both sections up, in every line.
- `docs-url-migration`: retiring an address the site never served, rather than redirecting it, is stated as a rule of its own instead of being tied to the one rename that first needed it.

## Impact

- `src/lib/custom-tree.ts` — the two hand-declared sidebars, and whatever the outward entries need from the node shape.
- `src/lib/resolveIcon.ts` and `src/lib/source.ts` — the two icon resolvers collapse into one, so an entry declared in the source can name a brand mark. The sidebar-validation gate already skips an entry that leaves the site, so it needs no change.
- `content/docs/ecosystem/index.mdx`, `content/docs/resources/**` — the overview rewrite and the renamed page.
- `content/docs/sdk/v0.18/**`, `content/docs/sdk/v0.19/**`, `content/docs/sdk/(v0.20)/**` — the two sections leave all three lines, taking their `meta.json` entries with them.
- `public/_redirects` and `tests/fixtures/pre-*-urls.json` — the production addresses of the moved pages must keep resolving, in one hop.
