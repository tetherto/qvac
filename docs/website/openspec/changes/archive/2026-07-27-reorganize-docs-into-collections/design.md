## Context

The site is a statically exported Next.js app (`output: 'export'`) on Fumadocs 16, with a single `fumadocs-mdx` collection defined by `defineDocs` in `source.config.ts` over the default `content/docs` directory, loaded with `baseUrl: '/'`. All 69 pages therefore live in one flat URL namespace at the root.

Three properties of the current implementation shape this design:

- **Navigation is hand-authored, not derived.** `src/lib/custom-tree.ts` exports a hardcoded `Node[]`, passed to the layout as `tree={{ name: 'docs', $id: 'latest', children: customTree }}`. There are no `meta.json` files anywhere under `content/`, so folder structure affects URLs but not the sidebar.
- **The layout is the notebook layout.** `src/app/(docs)/layout.tsx` imports `DocsLayout` from `fumadocs-ui/layouts/notebook` and already sets `nav.mode: 'top'`, so the navbar is a full-width top bar rather than a sidebar header.
- **One catch-all route serves every page.** `src/app/(docs)/[[...slug]]/page.tsx` renders all pages, and `src/lib/source.ts` feeds the sitemap, the Orama search index, `llms.txt` / `llms-full.txt`, the per-page Markdown files, and the OG images from the same loader.

Redirects are not application code: `public/_redirects` is consumed by the CDN, and its last rule is a catch-all `/*  /404.html  404`.

Two test gates constrain the work. `tests/sidebar-consistency.test.ts` asserts that every URL in the hand-authored tree resolves to a content file, and `tests/link-integrity.test.ts` plus the `@vahor/next-broken-links` step in `build` assert that no internal link is broken.

## Goals / Non-Goals

**Goals:**

- Partition the existing content into four collections without authoring documentation content.
- Let readers switch collection from a second navigation row, and see only the active collection in the sidebar.
- Keep every pre-existing URL resolving, and keep both link gates green.
- Leave the door open for per-collection versioning without redoing this work.

**Non-Goals:**

- Versioning of any kind, including the versioning that API reference and Release notes already have, the sidebar version switcher, and in-content version badges.
- Authoring the pages the target information architecture anticipates but that do not exist.
- The App and Research collections.
- Redesigning the page header, the AI assistant, or search.

## Decisions

### Keep one Fumadocs MDX collection; a collection is a top-level content folder

`source.config.ts` keeps its single `defineDocs` over `content/docs`, and `src/lib/source.ts` keeps one `loader()` with `baseUrl: '/'`. A collection is nothing more than a top-level folder whose name prefixes the URL.

The alternative was one `defineDocs` (or `defineCollections`) plus one `loader()` per collection, each with its own `baseUrl`. Rejected for now: the sidebar is hand-authored, so a separate page tree per loader buys nothing we do not already get from root folders inside the one hand-authored tree, and every derived surface — sitemap, search route, `llms.txt`, the Markdown manifest, OG images — currently reads from exactly one loader. Splitting the loader means touching all of them for no behavioural gain. The split becomes worthwhile when collections are versioned independently, because then each needs its own `baseUrl` and version resolution; deferring it keeps this change reviewable.

### Render the collection bar with Fumadocs Layout Tabs, not a custom component

Fumadocs has a first-class concept for exactly this: **Layout Tabs**, driven by **root folders**. A folder node carrying `root: true` becomes a tab, and the framework does the rest. This is the idiomatic way to segregate a Fumadocs site into sections, and adopting it means the navigation work is configuration rather than code.

Two framework behaviours make it sufficient on its own, and both are worth stating because they remove work that would otherwise look necessary:

- **Tabs are derived from the tree.** The tab list is an option of the layout's `sidebar` prop, `sidebar.tabs`, and there is no top-level `tabs` prop on either layout. Left unset, it defaults to `getSidebarTabs(tree)`, which walks the tree, collects every folder with `root: true`, and builds each tab from that folder — its `name` becomes the title, its `description` the subtitle, and its `index` (or first page) the landing URL. No separate tab list has to be declared or kept in sync with the tree.
- **The active tab is resolved from the pathname, inside the framework.** `TreeContextProvider` matches the current pathname against the tree, then takes the last root folder on that path as the active root. The sidebar renders that root's children, not the whole tree. Scoping the sidebar to a collection therefore requires no work at all: it is what a root folder already means.

On the notebook layout, `tabMode` selects where the tabs render, and `tabMode="navbar"` places them in the navbar area. Combined with the `nav.mode: 'top'` the layout already sets, this is the exact combination the Fumadocs notebook documentation demonstrates, and it produces the two-row header the target design calls for: a first row with the logo, search, assistant, and product links, and a second row with the collection tabs, active one marked, while the sidebar shows only the active collection.

Note that `tabMode` differs between layouts: the default docs layout takes `'top' | 'auto'`, while the notebook layout takes `'sidebar' | 'navbar'`. This site uses the notebook layout, so `'navbar'` is the correct value.

### Keep one hand-authored tree; each top-level node becomes a root folder

`src/lib/custom-tree.ts` stays a single module exporting a single `customTree`. Its top level changes from a flat list of pages, folders, and separators into exactly four folder nodes — Platform, SDK, Provider, Resources — each carrying `root: true`, each holding what is today at the top level. The layout keeps passing the same single tree it passes now:

```tsx
tree={{ name: 'docs', $id: 'latest', children: customTree }}
```

The other change to the layout is adding `tabMode="navbar"`; the tab list and the `fallback` tree that follow from the decision below are the rest of it. There is no registry, no per-collection tree module, and no routing change: the existing `(docs)/layout.tsx` above `[[...slug]]` stays exactly where it is, because it never needs to know which collection is active.

Give each collection folder an `index` so its tab lands on a predictable page rather than on whichever page happens to come first. Inside a folder, the current authoring style is unchanged, including `separator` nodes for grouping.

Alternatives considered, and why they were dropped. Splitting `custom-tree.ts` into one module per collection behind a registry, with an explicit `tabs` array and a `[collection]` dynamic route segment so the layout could select a tree from `params`, would also work — it was the first design here. It is strictly more code for the same result: a registry to maintain, a tab list that can drift from the tree, a route restructure, and a `generateStaticParams` change. It is only justified once collections are versioned independently and each needs its own loader and `baseUrl`. Declaring the collections with `meta.json` files carrying `root: true` is the other documented route, but this site has no `meta.json` at all and deliberately hand-authors its navigation, so keeping the declaration in `custom-tree.ts` matches the existing convention.

A welcome consequence: because the navigation stays one hand-authored tree, `tests/sidebar-consistency.test.ts` keeps working — it already walks the tree recursively collecting URLs, and root folders are just folders to it.

### Give the pages that are not in the tree a collection anyway

Making the tree carry the collections means the tree now answers a question it never had to before: which collection a page belongs to. Fumadocs answers it by looking the pathname up in the tree, so a page the tree does not list belongs to nothing — no tab marked, and a sidebar that falls back to listing the four collections. The 16 archived version pages are exactly that: deliberately absent from the sidebar, because the version selector is how a reader moves between them. Two mechanisms put them back:

- **The collection bar gets its entries explicitly**, derived from the same root folders (`collectionTabs`). A tab built by the framework carries the set of URLs declared under its folder and marks itself active only for those; a tab without that set matches the pathname against its own URL instead. Prefix matching is the better rule regardless — "the page lives under `/sdk`" is what belonging to the SDK collection means — and it needs no list to stay in sync.
- **The sidebar gets them through the tree's `fallback`**, a second tree the framework searches only when the main one misses. Each archived page becomes the `index` of a root folder that mirrors SDK and shares its children. `index` is matched during resolution but is the one node a root folder never renders, so the page joins the collection without appearing in its navigation, and reads as an ordinary SDK page.

Listing the archived pages as ordinary children of a fallback SDK folder was the first attempt. It made them sidebar entries on those pages, and the build's broken-link check rejected their URLs: an archived slug ends in a dot-bearing segment (`v0.8.x`), which the checker reads as a file. That form only resolves with a trailing slash, which the tree cannot carry because URL lookup compares against the node's URL verbatim. Using `index` sidesteps the conflict — the URL is matched, never linked.

### Generate the redirects and verify them by replaying the old URL list

Every URL changes, so there are as many redirects as there are pages. Hand-maintaining that list invites omissions, so capture the pre-move URL set, emit one `_redirects` entry per moved page from the move mapping, and add a check that replays the captured set against the built site. Root gets an explicit entry to the Platform overview.

Order matters: entries must precede the terminal `/*  /404.html  404` rule, otherwise the catch-all wins and the redirect never fires.

### Move content with `git mv`, and land navigation before content

Use `git mv` so history follows each page. Sequence the work so the navigation plumbing — the root folders and `tabMode="navbar"` — lands and is verified against a single collection before 69 files move. A visual spike of `tabMode="navbar"` comes first of all, because it is the one assumption that, if wrong, changes the design rather than the tasks.

## Risks / Trade-offs

- **`tabMode="navbar"` may not render as two distinct rows** → Resolved by the spike, so no fallback is needed. `#nd-subnav` renders as a `flex-col` holding two sibling rows, `data-header-body` at `h-14` and `data-header-tabs` at `h-10`, and the header-height token goes from `--spacing(14)` to `--spacing(24)` at the `lg` breakpoint, which is the two heights summed. The active tab carries `border-b-2 border-fd-primary`, the underline the target design calls for.
- **Below the `lg` breakpoint the tabs are not a bar** → Accepted as-is after review. `data-header-tabs` is `max-lg:hidden`, and on small screens Fumadocs moves the collection switcher into a dropdown button at the top of the sidebar drawer, listing the same collections and marking the same one active. The second row is therefore a wide-viewport treatment rather than a universal one, and `collection-navigation` states the requirement in those terms.
- **A missed redirect silently 404s an indexed URL** → Generate redirects from the move mapping rather than by hand, and gate on replaying the captured pre-move URL set. Never let the catch-all sit above the generated block.
- **Scripts resolve pages by hardcoded path** → The generation and versioning scripts under `scripts/`, and `src/lib/versions.ts`, locate pages by path, notably the 16 version-archive pages under `reference/`. Inventory those references before moving and update them in the same step, then run the generation pipeline to confirm.
- **The generated `.source/` registry goes stale after a large move** → It is produced by the `fumadocs-mdx` postinstall step and already lists a file that has since moved to `content/_unpublished/`. Regenerate it as part of the move and treat a stale entry as a build error, not a warning.
- **A 69-file move produces an unreviewable diff** → Land it as separate commits: navigation plumbing, then one commit per collection, then redirects and link fixes. Reviewers can follow each collection independently.
- **External consumers cached the old machine-readable surfaces** → `llms.txt`, the Markdown manifest, and the sitemap regenerate with new URLs, but anything that fetched them earlier holds pre-move paths. The redirects cover it; no separate mitigation is planned.
- **Provider ships thin** → Only the three HTTP-server pages plus a new overview have existing content, so the collection launches without the Installation, Configuration, API reference, and Troubleshooting sections its target shape anticipates. Accepted deliberately: the alternative is authoring content, which this change excludes.

## Migration Plan

1. Spike `tabMode="navbar"` against the current single tree and confirm the two-row header.
2. Wrap the current top level in one root folder, keeping all content where it is, and confirm the tab renders and the site still builds.
3. Move content one collection at a time with `git mv`, adding each collection's root folder as it lands.
4. Add the two permitted new pages, the Provider overview and the Resources index.
5. Generate `_redirects` from the move mapping, above the catch-all, and replay the captured pre-move URL set.
6. Fix internal links and run the full build with both link gates.

Rollback is a branch revert: nothing here migrates data or changes deployment configuration, and `_redirects` is inert once the paths it points at are gone.

## Open Questions

- The sidebar-less home of the target design is deliberately deferred. This change redirects the root into the Platform overview, so Platform's overview is the entry point; a later change introduces the standalone home and the requirement that it renders without a sidebar.
- Whether `cli/index.mdx` belongs in SDK long term. It is placed there because the CLI is an SDK-adjacent tool, while the HTTP-server pages under it describe the provider server and move to Provider — so the current CLI folder is split across two collections.
