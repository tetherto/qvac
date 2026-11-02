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

The site is partitioned into four collections: `sdk/`, `cli/`, `ecosystem/`, `resources/`. Only the first two document a release, and each of them is cut into **documentation lines** — one folder per published version, under `content/docs/<collection>/`.

The line still being written is not among them. It lives outside the site, at `content/_unpublished/<collection>/next/`, where nothing builds it and no URL reaches it. It is published at the release cutoff, by being copied into the collection as the new parenthesized folder.

```text
content/_unpublished/sdk/next/   being written — the next release, no URL
content/docs/sdk/(v0.20)/        cut — answers /sdk/…
content/docs/sdk/v0.19/          cut — answers /sdk/v0.19/…
content/docs/sdk/v0.18/          cut
content/_unpublished/cli/next/   being written
content/docs/cli/(v0.14)/        cut — answers /cli/…
content/docs/cli/v0.13/          cut
```

**This skill writes to the development line and to nothing else.** It documents the working tree, which is the release not yet cut. Every folder under `content/docs/<collection>/` documents a release that already shipped, so adding a new parameter to `sdk/(v0.20)/` would assert that the shipped 0.20 had it. Cut lines stay editable by hand for corrections; that is a human decision and never this skill's.

The name is fixed — `next`, not the version — so that the path stays the same across a cutoff. A PR writing this line, opened before the cutoff and merged after it, lands in the path it was written to, with no rename for git to replay it through. What a cutoff does change is which release that path belongs to: documentation meant to ship with the release has to merge before the cut, or it reaches readers a version late. No check catches that — `Documentation lines` reads `content/docs/` only, so a PR writing this line is never failed by it. The cutoff reads that window instead, listing the open PRs writing this line before cutting.

`docs/website/src/lib/versions.ts` is the manifest that declares the cut lines, and `tests/line-structure.test.ts` fails the build if it and the folders disagree. `<sdk-line>` and `<cli-line>` below stand for the development lines. `route-docs-targets.ts` and `check-capability-parity.ts` resolve them the same way and exit 2 if a collection carries no development line. `collect-source-changes.sh` reads only `packages/**` and never needs them.

## Allowlist — freely editable

```text
<sdk-line>/ai-capabilities/**
<sdk-line>/configuration/**
<sdk-line>/models/**
<sdk-line>/p2p-capabilities/**
<sdk-line>/runtime/**
<sdk-line>/index.mdx
<sdk-line>/js-ts-sdk.mdx
<sdk-line>/python-sdk.mdx
<sdk-line>/system-requirements.mdx
<cli-line>/**
```

`<sdk-line>/index.mdx` is the SDK collection overview, the page that carries `### AI tasks`, `### P2P capabilities` and `### Utilities`. Those three lists are a registration point for the page-creation subprocedures.

## Restricted allowlist — append-only, page-creation subprocedures only

These three files are read-only in every state except `NEW_CAPABILITY_PAGE` and `NEW_MODELS_PAGE`. Even there, the only accepted diff is an append inside the one block the subprocedure names.

| Path | State | Permitted operation |
| --- | --- | --- |
| `docs/website/content/docs/ecosystem/index.mdx` | `NEW_CAPABILITY_PAGE` | append 1 `<Card>` at the end of the `## AI capabilities` grid, and add 1 identifier to the `lucide-react` import |
| `<sdk-line>/ai-capabilities/meta.json` | `NEW_CAPABILITY_PAGE` | append 1 slug at the end of the `pages` array |
| `<sdk-line>/models/meta.json` | `NEW_MODELS_PAGE` | append 1 slug at the end of the `pages` array |

`ecosystem/index.mdx` is the page the old site index became, and its AI-capabilities grid still links every capability — now at `/sdk/ai-capabilities/<slug>`. It takes no edit under `NEW_MODELS_PAGE`: its only grid is `## AI capabilities`, and a model-lifecycle topic is not one, so there is no card to append.

A `meta.json` is on the list because a versioned collection declares its own navigation. Each line folder carries `meta.json` files listing its pages in order, and the sidebar is composed from them at build time. The list is explicit and has no catch-all, so a page absent from it is reachable by URL and invisible in navigation.

`src/lib/custom-tree.ts` is **not** on this list and must never be edited by this skill. It declares the sidebars of the two unversioned collections, Ecosystem and Resources, which this skill never adds a page to. The SDK and the CLI declare nothing there.

Never reorder, rewrite, or remove an existing entry in any of the three. That is a scope violation. So is touching `ecosystem/index.mdx` outside the AI-capabilities grid: the `## Why QVAC?` section, the `## Features` section, `## System overview`, `## Next steps`, and the rest of that page are off-limits.

## Denylist — never written, in any state

```text
docs/website/content/docs/sdk/**               # lines already cut
docs/website/content/docs/cli/**               # lines already cut
<sdk-line>/reference/**                        # generated deterministically
<sdk-line>/how-it-works.mdx
docs/website/content/docs/ecosystem/**         # except the grid append above
docs/website/content/docs/resources/**
packages/**                                    # source is never edited
```

The two collection globs deny every line that has been cut, which is everything the site serves. They cannot collide with the allowlist: the line this skill writes to is outside `content/docs/` entirely.

`reference/**` gets an explicit entry because it is the most tempting wrong answer. The API summary is produced from the SDK source by the generators in `docs/website/scripts/`, in every line, and the release-notes entry beside it is a link to that minor's GitHub release rather than a page. A hand-written patch there is overwritten at the next release cutoff.

`how-it-works.mdx` explains the architecture behind the SDK rather than how to use it. It moved into the SDK line from the old `about/` section and keeps that section's read-only status.

`resources/**` holds what supports the products without documenting a release of one: the tutorials, troubleshooting, and Build with AI. None of it varies by release, which is why it sits outside the lines — and why a source change is the wrong trigger for editing it.

Everything under `docs/website/` that is not in an allowlist above is read-only too: all of `src/`, plus `scripts/`, `tests/`, `public/`, and all config.

## Routing consequence

If a candidate page falls outside the allowlist, then discard it. Never rewrite it. Record the discard in the report with its reason, so a recurring near-miss is visible instead of silent. A semantically correct hit on a denylisted page still loses to this file.
