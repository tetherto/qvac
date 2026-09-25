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

## Collections, and the one line this skill writes to

The site is partitioned into four collections, each a folder under `content/docs/`: `sdk/`, `cli/`, `ecosystem/`, `resources/`. Only the first two document a release, and each of them is cut into **documentation lines** — one folder per published version.

The current line is the folder whose name is parenthesized. Fumadocs treats that as a group and drops it from the URL, so the current line is what answers the version-less addresses a reader normally follows. Every other folder is a line already cut and serves its version segment.

```text
content/docs/sdk/(v0.20)/   current — answers /sdk/…
content/docs/sdk/v0.19/     cut     — answers /sdk/v0.19/…
content/docs/sdk/v0.18/     cut
content/docs/cli/(v0.14)/   current — answers /cli/…
content/docs/cli/v0.13/     cut
content/docs/cli/v0.12/     cut
```

**This skill writes to the current line and to nothing else.** It documents the working tree, which is the release not yet cut. An older line documents a release already shipped, so adding a new parameter to `sdk/v0.19/` would assert that the shipped 0.19 had it. Older lines stay editable by hand for corrections; that is a human decision and never this skill's.

Never hardcode the folder — it changes at every release. Resolve it each run:

```bash
ls docs/website/content/docs/sdk | grep '^(v'   # -> (v0.20)
ls docs/website/content/docs/cli | grep '^(v'   # -> (v0.14)
```

`docs/website/src/lib/versions.ts` is the manifest that declares the lines, and `tests/line-structure.test.ts` fails the build if it and the folders disagree. `<line>` below stands for the resolved folder. `route-docs-targets.ts` and `check-capability-parity.ts` resolve it the same way and exit 2 if a collection has anything other than exactly one current line. `collect-source-changes.sh` reads only `packages/**` and never needs it.

## Allowlist — freely editable

```text
docs/website/content/docs/sdk/<line>/ai-capabilities/**
docs/website/content/docs/sdk/<line>/configuration/**
docs/website/content/docs/sdk/<line>/models/**
docs/website/content/docs/sdk/<line>/p2p-capabilities/**
docs/website/content/docs/sdk/<line>/runtime/**
docs/website/content/docs/sdk/<line>/index.mdx
docs/website/content/docs/sdk/<line>/js-ts-sdk.mdx
docs/website/content/docs/sdk/<line>/python-sdk.mdx
docs/website/content/docs/sdk/<line>/system-requirements.mdx
docs/website/content/docs/cli/<line>/**
```

`sdk/<line>/index.mdx` is the SDK collection overview, the page that carries `### AI tasks`, `### P2P capabilities` and `### Utilities`. Those three lists are a registration point for the page-creation subprocedures.

## Restricted allowlist — append-only, page-creation subprocedures only

These three files are read-only in every state except `NEW_CAPABILITY_PAGE` and `NEW_MODELS_PAGE`. Even there, the only accepted diff is an append inside the one block the subprocedure names.

| Path | State | Permitted operation |
| --- | --- | --- |
| `docs/website/content/docs/ecosystem/index.mdx` | `NEW_CAPABILITY_PAGE` | append 1 `<Card>` at the end of the `## AI capabilities` grid, and add 1 identifier to the `lucide-react` import |
| `docs/website/content/docs/sdk/<line>/ai-capabilities/meta.json` | `NEW_CAPABILITY_PAGE` | append 1 slug at the end of the `pages` array |
| `docs/website/content/docs/sdk/<line>/models/meta.json` | `NEW_MODELS_PAGE` | append 1 slug at the end of the `pages` array |

`ecosystem/index.mdx` is the page the old site index became, and its AI-capabilities grid still links every capability — now at `/sdk/ai-capabilities/<slug>`. It takes no edit under `NEW_MODELS_PAGE`: its only grid is `## AI capabilities`, and a model-lifecycle topic is not one, so there is no card to append.

A `meta.json` is on the list because a versioned collection declares its own navigation. Each line folder carries `meta.json` files listing its pages in order, and the sidebar is composed from them at build time. The list is explicit and has no catch-all, so a page absent from it is reachable by URL and invisible in navigation.

`src/lib/custom-tree.ts` is **not** on this list and must never be edited by this skill. It declares the sidebars of the two unversioned collections, Ecosystem and Resources, which this skill never adds a page to. The SDK and the CLI declare nothing there.

Never reorder, rewrite, or remove an existing entry in any of the three. That is a scope violation. So is touching `ecosystem/index.mdx` outside the AI-capabilities grid: the `## Why QVAC?` section, the `## Features` section, `## System overview`, `## Next steps`, and the rest of that page are off-limits.

## Denylist — never written, in any state

```text
docs/website/content/docs/sdk/v*/**            # lines already cut
docs/website/content/docs/cli/v*/**            # lines already cut
docs/website/content/docs/*/*/reference/**     # generated deterministically
docs/website/content/docs/sdk/<line>/how-it-works.mdx
docs/website/content/docs/ecosystem/**         # except the grid append above
docs/website/content/docs/resources/**
packages/**                                    # source is never edited
```

The two line globs are exact because of how a line folder is named: the current line starts with `(`, every cut line with `v`. `sdk/v*` therefore matches the cut lines and never the current one.

`reference/**` gets an explicit entry because it is the most tempting wrong answer. The API summary and the release notes are produced from the SDK source by the generators in `docs/website/scripts/`, in every line. A hand-written patch there is overwritten on the next release.

`how-it-works.mdx` explains the architecture behind the SDK rather than how to use it. It moved into the SDK line from the old `about/` section and keeps that section's read-only status.

`resources/**` holds what supports the products without documenting a release of one: the tutorials, troubleshooting, and Build with AI. None of it varies by release, which is why it sits outside the lines — and why a source change is the wrong trigger for editing it.

Everything under `docs/website/` that is not in an allowlist above is read-only too: all of `src/`, plus `scripts/`, `tests/`, `public/`, and all config.

## Routing consequence

If a candidate page falls outside the allowlist, then discard it. Never rewrite it. Record the discard in the report with its reason, so a recurring near-miss is visible instead of silent. A semantically correct hit on a denylisted page still loses to this file.
