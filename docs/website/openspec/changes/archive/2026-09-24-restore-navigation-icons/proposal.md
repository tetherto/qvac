## Why

Moving the versioned collections' navigation from the site source into each line's `meta.json` changed where a page's icon is declared. It used to be declared beside the sidebar entry, in `custom-tree.ts`, and read by nothing else. It is now declared in the page's own frontmatter, and two surfaces read it: the sidebar, as before, and the page's `<h1>`, which had the code to render one all along and simply never had an icon to render.

The move cost six entries their icon outright, because the new declaration site is a field an entry either has or does not, and these six were not given one. The same move gave every other page an icon in its title, which the site has never shown and was never meant to.

## What Changes

- The `<h1>` stops rendering the page's icon. An icon identifies a page in a list of pages; beside a title the reader has already arrived at, it says nothing the title does not.
- The six entries that lost their icon get it back, in every line that carries them: the JS/TS SDK, Python SDK, Assess model fit, Music generation, and World simulation pages, and the HTTP-server folder in the CLI.
- Two of those icons are brand marks rather than Lucide glyphs, so the brand-icon allowlist the sidebar resolver already keeps is extended to cover them.
- Where an icon may be declared, and which surfaces render it, becomes specified. It is currently a property of which resolver happens to be reached from which component, and the two resolvers do not agree on what they can resolve.

## Capabilities

### New Capabilities

- `docs-icons`: where a page or folder icon is declared, which surfaces render it, and which must not. Covers the icon set available to a declaration, and the rule that a page identified by an icon in one line is identified by it in every line that carries the page.

### Modified Capabilities

None. No existing spec mentions icons.

## Impact

- `src/app/(docs)/[[...slug]]/page.tsx` — the `<h1>` stops rendering `titleIcon`, and drops the resolution that fed it.
- `src/lib/source.ts` — the `brandIcons` allowlist gains the two marks.
- The frontmatter of five pages and the `meta.json` of one folder, in each line that carries them.
- No URL changes, no content moves, no redirects.
