---
name: notice-generate
description: Generate NOTICE files with third-party attributions for all packages in the monorepo.
---

# NOTICE File Generator

Generate deterministic, sorted NOTICE files for individual packages or all packages at once, covering model, JS, Python, and C++ dependency attributions.

## When to use this skill

**Use when:**
- Generating or updating NOTICE files for any package
- Adding new third-party dependencies that need attribution
- Preparing a release that requires up-to-date NOTICE files
- User invokes `/notice-generate`

## Prerequisites

Before running, ensure `.env` is sourced and contains:
- `GH_TOKEN` -- GitHub token (access to private repos and GitHub API)
- `HF_TOKEN` -- HuggingFace token (model license verification)
- `NPM_TOKEN` -- npm registry token (private package resolution)

System requirements for Python scanning:
- `python3` and `pip` available in PATH (for `pip-licenses`)

## Workflow

1. Ask which package to generate NOTICE for (or `--all` for all packages)
2. Source `.env` in the shell
3. Run the generator script — this writes NOTICE files directly
4. Only use `--dry-run` if the user explicitly asks for it

**Do NOT commit changes.** The user will review and commit manually.

## Running the scripts

### Generate NOTICE for a specific package

```bash
source .env
node .cursor/skills/notice-generate/scripts/generate-notice.js <package-dir-name>
```

Example: `node .cursor/skills/notice-generate/scripts/generate-notice.js sdk`

For registry sub-packages use the full path:
- `qvac-lib-registry-server/client`
- `qvac-lib-registry-server/shared`

### Generate NOTICE for all packages

```bash
source .env
node .cursor/skills/notice-generate/scripts/generate-notice.js --all
```

### Dry-run (no file writes, safe for testing)

```bash
source .env
node .cursor/skills/notice-generate/scripts/generate-notice.js --all --dry-run
node .cursor/skills/notice-generate/scripts/generate-notice.js sdk --dry-run
```

In dry-run mode:
- No files are written (NOTICE, NOTICE_LOG.txt, FORBIDDEN_LICENSES.txt)
- All scans run fully (npm install, license-checker, pip-licenses, GitHub API, models)
- NOTICE content is previewed in the console instead of written to disk

### Check for disallowed licenses

```bash
source .env
node .cursor/skills/notice-generate/scripts/check-forbidden-licenses.js --all --dry-run
node .cursor/skills/notice-generate/scripts/check-forbidden-licenses.js --all
```

Uses an **allowlist** approach. The `ALLOWED_LICENSES` array in `config.js` controls which licenses pass:
- **Empty list (default)** -- every license is allowed (open gate). Useful while you are still cataloguing your deps.
- **Populated list** -- only those SPDX identifiers pass; anything else is a violation.

License strings from all sources (npm, PyPI, GitHub, models) are normalized to canonical SPDX ids before comparison, so adding `apache-2.0` to the list automatically covers `Apache 2.0`, `Apache Software License`, `Apache License 2.0`, etc.

If violations are found, writes `FORBIDDEN_LICENSES.txt` to the repo root and exits with code 1.

**Important:** The agent should NOT edit `ALLOWED_LICENSES` directly. Present the scan results to the user and let them decide which licenses to allow. The allowlist and normalization map live in `.cursor/skills/notice-generate/scripts/constants.js`.

### Generate license overview report

```bash
node .cursor/skills/notice-generate/scripts/generate-report.js
```

Reads existing NOTICE files across all packages (no scanning, no tokens needed) and produces `NOTICE_FULL_REPORT.txt` with:
- Global license distribution with counts and percentages
- Per-package breakdown by dependency type (models, JS, Python, C++)
- Packages with no dependencies listed separately

### What it produces

1. **Per-package `NOTICE`** file inside each scanned package directory (from `generate-notice.js`)
2. **`NOTICE_FULL_REPORT.txt`** license overview report (from `generate-report.js`, gitignored)
3. **`NOTICE_LOG.txt`** at the repo root with errors/warnings (gitignored)

## Scan types

| Type | What | Tool |
|------|------|------|
| Models | Model attributions from `models.prod.json` | Direct JSON parsing |
| JS | Production npm dependencies | `license-checker` (auto-installed via npx) |
| Python | Benchmark/script Python deps | `pip-licenses` (auto-installed in temp virtualenv) |
| C++ | vcpkg native dependencies | GitHub API + local portfile parsing |

## Package coverage

- **Models (full list)**: `sdk`, `qvac-lib-registry-server/client`
- **Models (by engine)**: All addon packages, mapped by engine name
- **JS**: Every package with dependencies in `package.json`
- **Python**: Packages with `requirements.txt` or `pyproject.toml` in benchmarks/scripts
- **C++**: Packages with `vcpkg.json`

## Addon-to-engine mapping

| Package directory | Engine |
|---|---|
| `qvac-lib-infer-llamacpp-embed` | `@qvac/embed-llamacpp` |
| `qvac-lib-infer-llamacpp-llm` | `@qvac/llm-llamacpp` |
| `qvac-lib-infer-nmtcpp` | `@qvac/translation-nmtcpp` |
| `qvac-lib-infer-onnx-tts` | `@qvac/tts-onnx` |
| `qvac-lib-infer-whispercpp` | `@qvac/transcription-whispercpp` |
| `ocr-onnx` | `@qvac/ocr-onnx` |
| `lib-infer-diffusion` | `@qvac/diffusion-cpp` |

## Sorting guarantee

All entries within every NOTICE file section are sorted deterministically using locale-independent collation. Re-runs on identical input always produce identical output, resulting in clean git diffs.

## Related scripts

- **Model license verification**: `npm run verify:licenses` in `packages/qvac-lib-registry-server` -- verifies model licenses in `models.prod.json` against HuggingFace/GitHub APIs (dry-run only, console output, fails on unverifiable).

## References

- Constants (allowlist, normalization, copyright): `.cursor/skills/notice-generate/scripts/constants.js`
- Package definitions & internal wiring: `.cursor/skills/notice-generate/scripts/lib/config.js`
- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
