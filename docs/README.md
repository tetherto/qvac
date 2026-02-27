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

## Commands

- **Development**: `npm run dev` → http://localhost:3000
- **Build**: `npm run build`
- **Docs generation** (when SDK is available): `npm run docs:generate-api -- <version>`
- **Update versions list**: `npm run docs:update-versions`

## API doc generation (SDK path)

The generator reads the **qvac-sdk** package (TypeScript entry and JSDoc). Set **`SDK_PATH`** in a `.env` file (copy from `.env.example` and set your path). Bun loads `.env` automatically when running the scripts. The SDK folder must contain `index.ts` and `tsconfig.json`.

**Generated API docs** (`content/docs/sdk/api/latest/` and `content/docs/sdk/api/v*/`) are in `.gitignore`; generate them locally with `npm run docs:generate-api -- <version>` or in CI.

## CI: Generate API docs (Phase 3)

The workflow **Generate API Documentation** (`.github/workflows/docs-generate-api.yml`) runs on manual trigger or `repository_dispatch`. It clones the SDK repo, generates MDX, and opens a PR.

**Setup:** In the docs repo, add a **repository variable**:
- **`SDK_REPOSITORY`**: `owner/repo` of the SDK (e.g. `myorg/qvac` if the SDK is at `packages/qvac-sdk`).

Optional **repository variable**:
- **`SDK_SUBPATH`**: Path to the SDK inside the repo (default `packages/qvac-sdk`). Set to empty if the SDK is at repo root.

**Run:** Actions → Generate API Documentation → Run workflow, enter version (e.g. `0.7.0`). The workflow clones the branch `release-qvac-sdk-<version>` (or tag `v<version>` or `main`), generates docs, and opens a PR on branch `docs/api-v<version>`.

## Path format (critical)

- API docs: `content/docs/sdk/api/vX.Y.Z/` (full semver, e.g. `v0.7.0`)
- Latest: `content/docs/sdk/api/latest/`

See **API-DOCS-AUTOMATION-COMPLETE-GUIDE.md** for automation, CI, and production script details.
