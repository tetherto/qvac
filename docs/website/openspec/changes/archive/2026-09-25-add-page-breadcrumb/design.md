## Context

Fumadocs' `DocsPage` renders a breadcrumb by default (`breadcrumb: { enabled = true }`), and the site has never configured it. The trail comes from `getBreadcrumbItemsFromPath`, which walks the path the tree context resolved for the current pathname and applies three rules:

- A folder marked `root` **resets** the accumulated trail — `items = []` — and contributes an entry only when `includeRoot` is passed.
- A folder whose `index` is the next element of the path is skipped, so a page that is also a folder's index appears once rather than twice.
- The current page is appended only when `includePage` is passed.

Both flags default to false. Everything the trail is missing follows from that.

The root here is the collection. `custom-tree.ts` declares every collection as a folder with `root: true` and `name: collection.name`, because that flag is what makes Fumadocs treat it as a Layout Tab and scope the sidebar to it. A versioned collection contributes one such root per line, each with its own `index` — `/sdk` for the current line, `/sdk/v0.18` for an older one.

The tree context resolves the active root with `path.findLast(item => item.type === 'folder' && item.root)`, so the `tree` the slot receives is that collection node, not the whole tree. `includeRoot` would therefore name the collection correctly, and for an older line would link that line's index.

Two flags would carry most of this. What they cannot carry is the shape of the endpoints: `includePage` appends the page **with its URL**, which the slot renders as a link to the page the reader is on, and on a collection's index page the two flags together produce two entries pointing at the same URL.

## Goals / Non-Goals

**Goals:**

- Name the whole path: the collection, the folders between, and the page.
- Keep a trail line-correct, so climbing out of an older line's page stays in that line.
- Leave the current page unlinked, as a breadcrumb's last item should be.
- Render nothing where a trail would say nothing.

**Non-Goals:**

- Changing which folders appear. A folder with no page of its own is skipped today and stays skipped; it has no URL to offer, and inventing one is a separate decision.
- Touching the sidebar, the collection bar, the line switcher, or the line notice in the page body.
- The `BreadcrumbList` in the page's JSON-LD. It is built independently in `docs-json-ld.ts`, for search engines rather than readers, and Google's guidance for it differs from what a rendered trail should do.
- Restyling. The slot keeps the classes the default one uses, so the trail looks as it does today with more entries in it.

## Decisions

### A slot component, not the two flags

`breadcrumb={{ includeRoot: true, includePage: true }}` is one line and produces the right entries. It was built and inspected before this was written, and it fails on both endpoints: the last entry is an anchor to the current page, and `/sdk` reads `SDK › Overview` with both entries pointing at `/sdk/`.

Neither is reachable through the options — `includePage` has no "without a link" form, and nothing suppresses a one-node trail. `DocsPage` accepts `slots={{ breadcrumb }}`, so the alternative is a component of roughly the same size as the one it replaces, calling the same `getBreadcrumbItemsFromPath` and differing only in what it does with the ends.

The cost is owning a component that tracks a framework one. It is small and the framework's part of it — the path walk — stays borrowed rather than copied.

### Compose with the library's walk, then correct the ends

The slot calls `getBreadcrumbItemsFromPath` with both flags on and adjusts the result, rather than walking the path itself. The walk encodes rules worth keeping and easy to get wrong: the root reset, the folder-index collapse, separators. Reimplementing it would mean rediscovering them, and diverging from them silently at the next upgrade.

What the slot owns is the two ends. It drops the page entry when its URL equals the root's — the collection index case — and renders the last remaining entry as text rather than a link.

### Nothing renders when the trail holds one entry

After the correction, a collection's index page is left with the collection alone. A trail of one entry, naming the page the reader is on, is not a path; it is the page's own title rendered twice. The default component already returns `null` on an empty list, so this extends a rule the framework set rather than introducing one.

The alternative — showing `SDK` on `/sdk` — was rejected for saying nothing, not for looking wrong.

### The trail is asserted against built pages

The rules that shape it belong to `fumadocs-core`, and the failure mode is a minor upgrade quietly changing one: the root stops resetting, or the folder-index collapse changes, and the trail grows a duplicate or loses the collection. Nothing in the build would notice, because every URL it names still resolves.

So the test reads the built HTML, as `check-navbar-links.ts` does for the link bar, and asserts the properties rather than the text: the first entry is the collection and links its own line's index, the last entry names the page and carries no link, and a collection index has no trail at all. Checking exact strings would make every title edit a test edit.

## Risks / Trade-offs

**A component that duplicates a framework component drifts from it** → It borrows the walk and owns ten lines around it, so an upgrade that changes the walk changes both. What it cannot inherit is styling, which is why the classes are copied verbatim rather than reworked; a Fumadocs restyle of the default breadcrumb would leave this one behind, and a test cannot catch that.

**A trail on every page adds a line above every heading** → It replaces a trail that was already there on most pages, with two more entries on those and a first appearance on pages one level deep. The pages that gain it are the ones that had the least context.

**Skipped index-less folders are more visible now** → `/sdk/ai-capabilities/rag` reads `SDK › RAG`, jumping a level the URL contains. That is today's behaviour and today's URL, but a fuller trail draws the eye to the gap. Giving those folders index pages is a content decision, out of scope here, and the trail is what makes the case for it visible.

**The collection entry on an older line points somewhere the reader may not expect** → `/sdk/v0.18/...` climbs to `/sdk/v0.18`, not `/sdk`. That is deliberate — a breadcrumb that silently moved a reader to another release would be worse — but it means the trail never leads out of an older line. The line switcher is what does that, and it sits directly above the sidebar.
