## Context

Two of the four collections are hand-declared in `src/lib/custom-tree.ts`: Ecosystem and Resources. The other two are versioned and read their navigation out of each line's `meta.json`. This change touches only the hand-declared pair, plus the SDK lines that give two sections up.

Three constraints shape the work.

The sidebar tree is also the structure Fumadocs resolves a page's collection against. `findPath` walks the roots in declaration order, depth-first, and returns the first chain whose leaf is a page node with a URL equal to the normalized pathname. The active root is the last root on that chain. Ecosystem is declared first, so any page node inside it that carries another collection's canonical URL would win the match and render that collection's pages under Ecosystem's sidebar.

The sidebar-consistency gate already tolerates off-site entries: `collectUrls` skips a node that is `external` or whose URL begins with `http`. Nothing has to change there for the Products and Research links. Cross-collection entries are checked like any other, which is what we want — they point at pages that must exist.

The site is a static export served from a CDN, so URL continuity is `public/_redirects` and nothing else. Two fixtures replay the promise: `pre-move-urls.json` at two redirect hops, `pre-versioning-urls.json` at one. Both list `/sdk/troubleshooting`, `/sdk/tutorials/electron`, `/sdk/tutorials/expo`, and their Markdown twins.

## Goals / Non-Goals

**Goals:**

- Give Ecosystem a sidebar that maps what QVAC publishes, including the parts documented elsewhere and the parts not documented here at all.
- Make an entry that leaves the collection a declarable thing, with the scoping requirement adjusted to admit it rather than quietly violated.
- Move Tutorials and Help to the collection that holds material belonging to no release, and out of the line folders that were copying them.
- Keep every address production serves resolving, in one hop.

**Non-Goals:**

- The icon regressions. They are a separate change, `restore-navigation-icons`, which landed first.
- Authoring new pages. Fabric, the assistant app, the Psy models, and the Genesis datasets are links to the main website; nothing is written for them here.
- Creating the `app` or `research` collections. Research is a separator inside Ecosystem, not a collection.
- Versioning anything in Resources, now or later.

## Decisions

### An outward internal entry is written in its trailing-slash form

An entry pointing into another collection is a plain page node with an internal URL, but it must be written as `/sdk/`, not `/sdk`. `searchPath` normalizes the pathname it is given and compares it against the node's URL exactly as written, so the slash-carrying form is unmatchable and cannot shadow the target collection's own root. It is also the form the CDN serves and the form Next renders, so nothing about the link degrades.

The alternative was to reorder `COLLECTIONS` so Ecosystem is visited last. That trades a local, testable property for a global one, and the declaration order is also the order of the collection bar, which is a product decision rather than a resolution detail. A second alternative, marking the entry `external: true`, was rejected because `findPath`'s matcher reads only the node's type and URL — the flag changes how the link renders, not whether it is matched.

This is subtle enough to be undone by someone tidying the slash, so the sidebar-consistency test gains an assertion that `/sdk`, `/cli`, and the model-provider page each resolve under their own collection's root.

### The two icon resolvers collapse into one

Planning treated this as a separate concern and left it out. Implementation showed it could not be: the two tutorials are identified by the Electron and Expo marks, Resources declares its navigation in the source, and the source-side resolver knew only Lucide. Moving the pages would have dropped both marks, which the `docs-icons` requirement that no entry loses its icon forbids.

The allowlist now lives in `resolveIcon.ts`, and `source.ts` passes that function to Fumadocs as its `icon` hook. One resolver, one allowlist, reached from both declaration sites — which is what the requirement that the icon set be a single deliberate allowlist already implied. A second allowlist beside it was the alternative, and it was rejected because two lists that must agree eventually will not.

### Off-site entries carry `external: true`

`Item` already has the field, and it makes Fumadocs render an `<a>` rather than a client-side link. It also documents the intent at the declaration site, which matters in a sidebar where most entries stay on the site.

### Tutorials and Help become unversioned, and leave every line

The two sections move to `content/docs/resources/tutorials/**` and `content/docs/resources/troubleshooting.mdx`, declared in `resourcesChildren`. Resources has no `meta.json`, so nothing is added there.

They leave `v0.18`, `v0.19`, and `(v0.20)` alike. The published requirement that an older line stays editable sanctions this: a line is an ordinary folder, not a frozen artifact. Leaving the sections in the older lines would keep three copies of a tutorial that never varied by release, and the reader switching lines would see the same page claim to be version-specific.

The six internal links to them — two per line, in `system-requirements.mdx` and `configuration/plugins/index.mdx` — are rewritten to `/resources/…`. The line-link resolver leaves them alone, because it only prefixes links into the page's own collection, so a single form works in all three lines.

### The moved pages' production addresses redirect in one hop

`/sdk/troubleshooting/`, `/sdk/tutorials/electron/`, `/sdk/tutorials/expo/`, and their `.md` twins gain a `301` to the Resources address. The pre-collections rules `/troubleshooting/` and `/tutorials/*` are retargeted at Resources rather than left to chain through the SDK, following the convention `public/_redirects` already states: a visitor following a years-old link should take one hop, not two. Left chained they would still pass, at exactly the two hops the fixture allows, with no margin.

The line-scoped addresses `/sdk/v0.18/tutorials/**` and `/sdk/v0.19/**` get nothing. The site has never served them: production is still on the pre-collections tree, and these paths exist only on this branch.

### The Corpus protocol rename retires its address

The page becomes Build with AI at `/resources/build-with-ai`, and `/resources/corpus-protocol` gets no rule. The same reasoning the collection rename already used applies: a redirect for an address no reader was served asserts a history the site does not have. The page was authored on this branch and appears in neither URL fixture.

That reasoning is currently written into a requirement about one specific rename. It is promoted to a requirement of its own, so the next rename does not have to re-derive it.

## Risks / Trade-offs

- **An outward entry shadows the target collection's sidebar.** → The trailing-slash form makes it unmatchable, and a new assertion in `tests/sidebar-consistency.test.ts` fails if the slash is ever dropped.
- **A reader leaves the site without noticing.** → Off-site entries are `external`, which Fumadocs marks in the sidebar; the on-site ones stay on the site, so the cost of a misread is a back button.
- **The Ecosystem sidebar names things this site does not document.** → That is the point of the collection, but it means the main website's URLs become a dependency of our navigation. A moved page there becomes a broken link here, and the broken-link check does not follow external URLs. Accepted, and noted rather than engineered around.
- **Removing pages from older lines rewrites what those lines published.** → No reader is affected, because the lines were never served. The requirement that an older line stays editable is what makes this ordinary rather than exceptional.
- **`/sdk/troubleshooting` stops being an SDK page while remaining an SDK-shaped address.** → It answers with a redirect, so the reader arrives; the cost is that the SDK collection no longer holds a troubleshooting page at all, which is the intended outcome.
