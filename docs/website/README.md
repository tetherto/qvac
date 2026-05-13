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