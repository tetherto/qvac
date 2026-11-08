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
- `versions`: one versions file per documented software, pinning every line it publishes.
- `scripts`: integration and automation between the codebase and automatic documentation generation.

## Documentation lines and versions files

Every software documented at more than one version is declared by one file
under `versions/` — today `sdk.json` and `cli.json`. Its shape is enforced by
`src/lib/versions-file.ts`; `src/lib/versions.ts` derives from these files the
manifest every version-shaped surface reads, and no other module reads them.

```jsonc
{
  "package": "@qvac/sdk",
  "kind": "product",                 // product | platform
  "path": "/sdk",                        // where it is documented
  "paths": ["packages/sdk/docs/users",   // the documentation root, first
            "packages/sdk/examples"],    // then whatever it imports
  "retired": ["v0.20"],                  // lines whose addresses redirect
  "lines": [
    { "version": "v0.24", "ref": "release-sdk-0.24.1", "sha": "<commit>" },
    { "version": "v0.23", "inPlace": true }
  ]
}
```

- **Line order is currency.** The first line is current and is served at the
  version-less paths; no other field marks it.
- **A pinned line** (`ref` + `sha`) is rendered from that commit.
  `npm run docs:materialize` extracts its `paths` into a gitignored snapshot
  under `.lines/<software>/<version>/`, transpiles its examples there, and
  copies its documentation root to `content/docs/<path>/<folder>/`, written as
  the folder group when the line is current. Its pages import their examples
  from the snapshot, so a line shows the examples of the commit it documents.
  A materialized folder carries a `.materialized` marker and ignores itself in
  git; it is removed when its line stops being declared.
- **An in-place line** (`inPlace: true`) is still held under `content/docs/`
  from before its software kept documentation in its package. It is
  transitional: the package migration replaces it with pinned lines.
- **No number of lines is imposed.** A line stays published until the team
  stops supporting it. Retiring it is one edit: move its version from `lines`
  to `retired`. The materializer then removes its folder, and its addresses
  redirect to the current line.
- **The redirect rules of every line are generated.** `public/_redirects`
  holds two `# @generated …` markers; after `next build`,
  `scripts/write-line-redirects.ts` expands them in `out/_redirects` into the
  rules of every published line that is not current and of every retired
  line, read from the versions files. Never write a line's rules by hand.

`npm run build` and `npm run dev` materialize before anything else. To preview
another state of one line, override it with a commit or a checkout:

```bash
bun run scripts/materialize-lines.ts --override sdk@v0.24=<sha-or-directory>
```

`npm run dev` also passes `--include-dev`, which adds each collection's
unreleased line, read from the working tree, at `/<collection>/preview/` —
once that software keeps its documentation in its package. Production builds
never pass it.

## Cutting a documentation line

**Only the CLI is still cut.** The SDK keeps its documentation in
`packages/sdk/docs/users/` and publishes a line by pinning its release commit
in `versions/sdk.json` (see "Documentation lines and versions files");
`cut-line.ts` refuses it. The CLI follows once it migrates.

A versioned collection publishes one folder per line it has cut:
the parenthesized one is a Fumadocs group, so its pages answer at the
version-less paths, and every plain one carries its version in the URL. A
cut adds a line and retires none; retiring a line is a separate edit to its
versions file.

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

Then edit the one hand-maintained input:

- `versions/sdk.json` — the SDK gains `{ "version": "v0.18", "inPlace": true }`
  at the top, which makes it current; the older entries stay as they are. The
  development line is not in this file; it is not published.

The preserved line's redirect rules follow from that file at build. A page
carried by both lines keeps resolving on its own, and a page the new line drops
is the only case that needs a rule of its own in `public/_redirects`.

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