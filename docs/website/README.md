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

## Publishing a documentation line

The SDK and the CLI keep their documentation in their packages:
`packages/sdk/docs/users/` and `packages/cli/docs/users/`. That folder on
`main` is the line being written; `npm run dev` previews it at
`/<collection>/preview/`. No line is cut and no folder is copied.

A release publishes its line by pinning it: the software's versions file
gains the line, first, with the release branch as `ref` and the release
commit as `sha`. A patch release moves the pin of its minor's line. A
correction to a released line is a documentation-only pull request into that
line's release branch, followed by moving the pin to the merged commit. The
build materializes every pinned line from its commit and generates its
redirect rules; finish with `npm run build` and `bun run vitest run`.

The lines published before the migration are still declared `inPlace` and
served from `content/docs/<collection>/`. When the first pinned line becomes
current, rename the in-place current folder from `(vX.Y)` to `vX.Y` in the
same pull request; retire the in-place lines as they age out.

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