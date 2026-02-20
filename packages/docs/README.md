# QVAC docs

Official documentation and single source of truth for QVAC:
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

Check broken links in dev env:
```bash
npm run check-links
```

Run dev env server:

```bash
npm run dev
```

## Build

Create a `.env.*` following `env.example`.

Generate static website:

```
npm run build:static
```

It generates static content into the `dist` directory and can be served using any static content hosting service.

Check in your local machine the static website:
```
npm run serve
```

## Deployment

TBD with DevOps team.

Planned address for release: [http://docs.qvac.tether.dev](http://docs.qvac.tether.io)

## Repository layout

- `src`: source code of docs website.
- `content/docs`: docs website content.
- `examples`: runnable QVAC code samples to be used as code snippets on content via code injection tools.
- `scripts`: integration and automation between the codebase and automatic documentation generation.

>[!NOTE]
> Temporary structure: it will be improved soon with the maturation of automation and better organization of the source code and the docs website content.