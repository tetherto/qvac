# QVAC docs

QVAC docs ecosystem website:
- Source code and content of the docs website.
- Automation scripts for the integration between the codebase and the documentation.

QVAC docs website is a static website generated via SSG functionality from a Next.js+[Fumadocs](https://fumadocs.dev) application.

## Installation

Prerequisites:
- Node.js >= 22.17.0
- `npm` >= 10.9.2

Install dependencies:
```
npm install
```

## Development

```bash
npm run dev
```

Open http://localhost:3001/ecosystem, not the site root. Every page lives under a collection, so `/` has no page of its own: in production the CDN redirects it to the Ecosystem overview, and the dev server never reads `public/_redirects`, so there it just 404s.

## Build

Create a `.env.*` following `env.example`.

Generate static website:

```
npm run build
```

It generates static content into the `out` directory and can be served using any static content hosting service.

Check in your local machine the static website:
```
npm run serve
```

## Environments

- Production: [http://docs.qvac.tether.io](http://docs.qvac.tether.io)
- Staging (protected with company auth): [http://docs.qvac.tether.su](http://docs.qvac.tether.su)

## Repository layout

- `src`: source code of docs website.
- `content/docs`: docs website content.
- `scripts`: integration and automation between the codebase and automatic documentation generation.

## Cutting a documentation line

A versioned collection — SDK, CLI — publishes one folder per line it has cut:
the parenthesized one is a Fumadocs group, so its pages answer at the
version-less paths, and every plain one carries its version in the URL. A line
is never retired: it is the only record of how that release behaved.

The line still being written is not among them. It lives at
`content/_unpublished/<collection>/next/`, which nothing builds and no URL
reaches, under a fixed name so the path a feature PR writes to does not move.

A cut publishes the line of the version being released. Cut at the **release
cutoff** — step 6 of [`../ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md) for a
train, step 1 of the release flow in [`../gitflow.md`](../gitflow.md) for a
single package.

One command does the whole thing, from `docs/website`:

```bash
bun run scripts/cut-line.ts sdk v0.18
```

It refuses a collection that is not versioned, a version that is not above the
line last cut, a missing development line, a destination already on disk, and a
working tree that already carries changes — the cut is reviewed as its own
diff. Review what it did, then `npm run build` and `npm test`.

The command is a convenience, not a dependency. What it does is the following,
and doing it by hand is the same cut. For `@qvac/sdk` releasing `0.18`, with
`0.17` the line last cut:

```bash
# 1. Preserve the outgoing line, which keeps serving what it served.
git mv 'content/docs/sdk/(v0.17)' content/docs/sdk/v0.17

# 2. Publish the line the sprint was written into — a copy, so the
#    development line stays where it is and becomes v0.19's.
cp -r content/_unpublished/sdk/next 'content/docs/sdk/(v0.18)'
```

Step 2 is a copy and not a move on purpose. Nothing is deleted and the
development line is never renamed, so a feature PR opened before the cutoff and
merged after it lands in the path it was written to — git has no deletion to
pair its edits against.

Step 1 **is** a rename, and the folder it opens in step 2 is byte-identical to
it wherever the sprint changed nothing. A PR that edits the outgoing group and
merges after the cut therefore gives git two exact rename candidates per page,
and git picks one, which is QVAC-27286. The `Documentation lines` job in
`.github/workflows/docs-website-pr-checks.yml` fails such a PR until it is
rebased — it is not a required check, so it asks rather than withholds — and
`qv-docs-cutoff` lists the PRs a cut will strand before making it.

Then edit the two hand-maintained inputs:

- `src/lib/versions.ts` — the SDK gains `{ version: 'v0.18', folder: '(v0.18)' }`
  at the top and its `v0.17` entry's folder becomes plain. The older entries stay
  as they are. The development line is not in this file; it is not published.
- `public/_redirects` — the line just preserved needs the pair every dotted
  segment needs, because the CDN reads `v0.17` as a file request and so never
  normalizes the trailing slash:

  ```
  /sdk/v0.17/     /sdk/v0.17/index.html   200
  /sdk/v0.17      /sdk/v0.17/             301
  ```

  Nothing else: a page carried by both lines keeps resolving on its own, and a
  page the new line drops is the only other case that needs a rule.

Then move the currency marker. A page that states in its own title which series
it documents also states whether that series is current, and the parentheses
are the only other place currency is recorded, so nothing else can maintain the
claim. Today that is the SDK's generated API summary: `v0.17.x (latest)` becomes
plain `v0.17.x` in the preserved line, and `v0.18.x (latest)` in the new one.
The development line carries no marker.

Then retarget the new line's release-notes link. `reference/meta.json` carries
the sidebar entry as an external link to that minor's GitHub release:

```
"external:[Release Notes](https://github.com/tetherto/qvac/releases/tag/sdk-v0.18.0)"
```

The copy brought the development line's tag with it, so rewrite it to the line
being opened. The tag exists within days: the release follows the cutoff, and
production is not promoted until it has.

Everything else follows: the sidebars come from the `meta.json` files the copy
brought with it, and the switcher, canonicals, agent artifacts, `versions.json`,
sitemap, and retrieval metadata are computed from the manifest. `custom-tree.ts`
is not edited by a cut.

Either way, finish with `npm run build` and `bun run vitest run`. Between them they reject a
cut that went wrong: a manifest that disagrees with the folders either way, a
collection left with no group or two, a patch-shaped folder name, a line
numbered above the group, a URL that stopped resolving, and an artifact that
reaches into another line. The one thing they do not check is the preserved
line's index pair — the broken-link check is told to ignore line indexes, and
the redirect replay reads the built output rather than the CDN's matcher — so
read that rule back yourself.

The Software Inventory is built but not published. Its pages wait under
`content/_unpublished/ecosystem/inventory/`, the manifest lists no package, and
`public/_redirects` carries no `:version` rules for it. Everything the inventory
needs is derived from the manifest, so publishing it is moving that folder back
under `content/docs/`, listing its packages again, and restoring one pair of
redirect rules per package — the comment in `_redirects` says how to write them.
Once published, documenting a release is the same shape one level down from a
line cut: add `content/docs/ecosystem/inventory/<pkg>/v<major>.<minor>/index.md`
with the README as released, add the row to that package's index, add the
manifest entry. The `:version` rules then already cover the new folder.

The Kotlin SDK is documented but not published, because the package is not
released yet. Its page waits under `content/_unpublished/sdk/kotlin-sdk.mdx`,
and the pages that enumerate the clients name only JS/TS and Python.
Publishing it is moving that page to `content/docs/sdk/(v0.20)/`, listing it in
that folder's `meta.json`, prefixing its internal links with the line scope,
and restoring the third client where the clients are counted. The Ecosystem
overview holds its share of that already, commented beside what it replaces —
the three-client paragraph and the Kotlin card, both line-scoped, so they go
live by uncommenting. The SDK line's index was left at two clients and needs
its five Kotlin passages written back by hand.

## CDN configuration (Sevalla)

Next.js static export emits per-segment React Server Component prefetch
payloads as `__next.*.txt` files alongside each page (`__next._tree.txt`,
`__next._head.txt`, `__next._index.txt`, `__next.<segment>.txt`). These files
are fetched on every link hover/visible to enable instant client-side
navigation; the layout shell (`__next.!KGRvY3Mp.txt`) is ~60 KB uncompressed.

Verify the CDN compresses them:

```bash
curl -sI -H 'Accept-Encoding: gzip, br' \
  https://docs.qvac.tether.io/__next._tree.txt | grep -i content-encoding
```

The response **must** include `content-encoding: gzip` or `content-encoding: br`.
If the header is missing, hover-prefetch performance suffers ~10x. Sevalla
auto-compresses common MIME types (`text/html`, `application/javascript`,
`text/css`); ensure `text/plain` is in its compressible-MIME allowlist, or
add a CDN rule rewriting `Content-Type` for `__next.*.txt` to
`text/x-component` (Next.js's actual MIME for these payloads).