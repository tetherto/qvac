# Docs scope — what `qv-docs-update` may write

This is the guardrail. Check every path against this file before writing a patch, and again in the Phase 6 scope gate. A write outside the allowlist aborts the run and reverts every patch already applied.

All paths are relative to the monorepo root.

## Observed sources — read-only

```text
packages/sdk
packages/sdk-python
packages/cli
```

Never edit anything under `packages/**`. If a source file is wrong — an example that no longer compiles, a TSDoc block that contradicts the code — report it and stop. Fixing source is the developer's job.

## Allowlist — freely editable

```text
docs/website/content/docs/ai-capabilities/**
docs/website/content/docs/cli/**
docs/website/content/docs/configuration/**
docs/website/content/docs/models/**
docs/website/content/docs/p2p-capabilities/**
docs/website/content/docs/runtime/**
docs/website/content/docs/introduction.mdx
docs/website/content/docs/js-ts-sdk.mdx
docs/website/content/docs/python-sdk.mdx
docs/website/content/docs/system-requirements.mdx
```

## Restricted allowlist — append-only, `NEW_CAPABILITY_PAGE` only

These two files are read-only in every state except `NEW_CAPABILITY_PAGE`. Even there, the only accepted diff is an append inside the AI-capabilities block.

| Path | Permitted operation |
| --- | --- |
| `docs/website/content/docs/index.mdx` | append 1 `<Card>` at the end of the `## AI capabilities` grid, and add 1 identifier to the `lucide-react` import |
| `docs/website/src/lib/custom-tree.ts` | append 1 entry at the end of the `AI capabilities` block, between the `AI capabilities` and `P2P capabilities` separators |

`custom-tree.ts` is on the list despite living outside `content/docs/` because the sidebar is a hand-maintained tree, not derived from the filesystem. A page with no entry there is reachable by URL and invisible in navigation.

Never reorder, rewrite, or remove an existing entry in either file. That is a scope violation. So is touching `index.mdx` outside the AI-capabilities grid: the `## Why QVAC?` section, the `## Features` section, and the rest of the home page are off-limits.

## Denylist — never written, in any state

```text
docs/website/content/docs/reference/**        # generated deterministically
docs/website/content/docs/about/**
docs/website/content/docs/tutorials/**
docs/website/content/docs/addons/**
docs/website/content/docs/troubleshooting.mdx
packages/**                                   # source is never edited
```

Everything under `docs/website/` that is not in an allowlist above is read-only too: `src/` except `custom-tree.ts`, plus `scripts/`, `tests/`, `public/`, and all config.

`reference/**` gets an explicit entry because it is the most tempting wrong answer. `scripts/release-version.ts` produces the API summary and the release notes from the SDK source. A hand-written patch there is overwritten on the next release.

## Routing consequence

If a candidate page falls outside the allowlist, then discard it. Never rewrite it. Record the discard in the report with its reason, so a recurring near-miss is visible instead of silent. A semantically correct hit on a denylisted page still loses to this file.
