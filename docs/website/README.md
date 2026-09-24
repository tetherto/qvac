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

A versioned collection — SDK, CLI — publishes two lines: the current one,
whose folder is a Fumadocs group so its pages answer at the version-less paths,
and the previous one, whose folder is plain so its pages carry the version. Cut
the next line as soon as a release goes live, not when the next one is being
prepared, so the version-less paths serve what was just released and new
material has a folder to land in.

The cut is four hand edits and no tooling. For `@qvac/sdk` going from `0.17` to
`0.18`, from `docs/website`:

```bash
# 1. Retire the oldest line: a collection carries two.
git mv content/docs/sdk/v0.16 content/_unpublished/sdk/v0.16

# 2. Preserve the outgoing line, which keeps serving what it served.
git mv 'content/docs/sdk/(v0.17)' content/docs/sdk/v0.17

# 3. Open the coming one as a copy, complete from the first build.
cp -r content/docs/sdk/v0.17 'content/docs/sdk/(v0.18)'
```

Then edit the two hand-maintained inputs:

- `src/lib/versions.ts` — the SDK's versions become
  `{ version: 'v0.18', folder: '(v0.18)' }` and
  `{ version: 'v0.17', folder: 'v0.17' }`.
- `public/_redirects` — the preserved line needs the pair every dotted segment
  needs, and the retired one a rule sending its pages to the current line:

  ```
  /sdk/v0.17/     /sdk/v0.17/index.html   200
  /sdk/v0.17      /sdk/v0.17/             301
  /sdk/v0.16/*    /sdk/                   301
  /sdk/v0.16      /sdk/                   301
  ```

Everything else follows: the sidebars come from the `meta.json` files the copy
brought with it, and the switcher, canonicals, agent artifacts, `versions.json`,
sitemap, and retrieval metadata are computed from the manifest. `custom-tree.ts`
is not edited by a cut.

Finish with `npm run build` and `bun run vitest run`. Between them they reject a
cut that went wrong: a manifest that disagrees with the folders either way, a
collection left with no group or two, a third line (naming the oldest), a
patch-shaped folder name, a line numbered above the group, a URL that stopped
resolving, and an artifact that reaches into another line.

Documenting an inventory release is the same shape one level down: add
`content/docs/ecosystem/inventory/<pkg>/v<major>.<minor>/index.md` with the
README as released, add the row to that package's index, add the manifest entry.
The `:version` rules in `public/_redirects` already cover the new folder.

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