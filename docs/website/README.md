# QVAC Documentation Site

Next.js documentation site using [Fumadocs](https://www.fumadocs.dev), aligned with **API-DOCS-AUTOMATION-COMPLETE-GUIDE.md**.

## Structure (from api-docs guide)

```
docs/
├── content/
│   └── docs/
│       ├── overview/           # No versioning
│       ├── sdk/
│       │   └── api/
│       │       ├── latest/    # Copy of newest version
│       │       ├── v0.7.0/    # Versioned API docs (vX.Y.Z)
│       │       └── ...
│       ├── workbench/
│       ├── health/
│       └── contributors/
├── scripts/
│   ├── generate-api-docs.ts   # TypeDoc → MDX (see guide Appendix E)
│   └── update-versions-list.ts
├── src/
│   ├── app/
│   ├── components/            # e.g. version-switcher
│   └── lib/                  # source, versions
├── source.config.ts          # Fumadocs MDX config
└── package.json
```

## Quick start (fresh clone)

After cloning, the baseline docs pages (Overview, Health, Workbench, Contributors) are committed and will render immediately. The SDK API reference pages are **generated** and not committed. To get them:

```bash
cd docs/website
npm install
cp .env.example .env          # then set SDK_PATH to your sdk location
bun run scripts/generate-api-docs.ts 0.7.0
npm run dev
```

Without running the generation step, `/docs` will load but SDK API links will 404.

## Commands

- **Development**: `npm run dev` → http://localhost:3000
- **Build**: `npm run build`
- **Generate API docs**: `bun run scripts/generate-api-docs.ts <version>` (requires `SDK_PATH` in `.env`)
- **Update versions list**: `npm run docs:update-versions`

## API doc generation (SDK path)

The generator reads the **sdk** package (TypeScript entry and JSDoc). Set **`SDK_PATH`** in a `.env` file (copy from `.env.example` and set your path). Bun loads `.env` automatically when running the scripts. The SDK folder must contain `index.ts` and `tsconfig.json`.

**Generated API docs** (`content/docs/sdk/api/latest/`, `content/docs/sdk/api/v*/`, `content/docs/sdk/api/.latest-backup/`) are in `.gitignore`; generate them locally with `bun run scripts/generate-api-docs.ts <version>` or in CI. Baseline content (index, overview, health, workbench, contributors) is committed.

## CI: Generate API docs (Phase 3)

The workflow **Generate API Documentation** (`.github/workflows/docs-generate-api.yml`) runs on manual trigger or `repository_dispatch`. It clones the SDK repo, generates MDX, and opens a PR.

**Setup:** In the docs repo, add a **repository variable**:
- **`SDK_REPOSITORY`**: `owner/repo` of the SDK (e.g. `myorg/qvac` if the SDK is at `packages/sdk`).

Optional **repository variable**:
- **`SDK_SUBPATH`**: Path to the SDK inside the repo (default `packages/sdk`). Set to empty if the SDK is at repo root.

**Run:** Actions → Generate API Documentation → Run workflow, enter version (e.g. `0.7.0`). The workflow clones the branch `release-qvac-sdk-<version>` (or tag `v<version>` or `main`), generates docs, and opens a PR on branch `docs/api-v<version>`.

## Path format (critical)

- API docs: `content/docs/sdk/api/vX.Y.Z/` (full semver, e.g. `v0.7.0`)
- Latest: `content/docs/sdk/api/latest/`

See **API-DOCS-AUTOMATION-COMPLETE-GUIDE.md** for automation, CI, and production script details.
