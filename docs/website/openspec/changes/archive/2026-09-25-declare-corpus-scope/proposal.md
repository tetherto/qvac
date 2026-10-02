## Why

A line's `llms-full.txt` drops the line's release notes and says nothing about it. The omission is deliberate — a changelog is bulk text that inflates the token count without helping an agent use the release (QVAC-21379) — but it is invisible at the point it matters. The line index advertises `Total pages: 36` and names the corpus as "Full text of this line in one fetch"; the corpus that arrives holds 35 and opens straight into the first page, with no statement of what it is or what it left out. An agent reading it has no way to tell a deliberate exclusion from a page that was never written, and will answer "this release documents no changes" with confidence.

The site-wide corpus already solves this. It opens with a contents block naming what it carries and what it excludes, release notes included. The six line corpora carry no such block, and the spec does not require one — it says a line corpus holds "the full text of that line's pages and nothing else", which the exclusion already contradicts. The gap is between what the corpora do and what the spec claims they do.

## What Changes

- Every line corpus opens with a contents block, as the site-wide corpus already does: the collection and line it covers, the package and release those track, whether the line is current, and where its index and the other lines' corpora are.
- That block states the release-notes exclusion and names the page to fetch for it, so an agent can recover what the corpus withheld.
- The published requirement stops claiming a corpus holds a line's pages and nothing else. It states the exclusion, and requires the corpus to declare its own scope.
- The build gate checks for the declaration, so a corpus that ships without one fails rather than shipping silently — the same failure mode this change exists to close.

## Capabilities

### New Capabilities

None. The behaviour belongs to a capability that already owns it.

### Modified Capabilities

- `versioned-agent-artifacts`: the corpus requirement stops describing a line corpus as its pages "and nothing else". It states what a corpus excludes and requires every corpus to open by declaring its own scope, so a reader can tell the corpus from the line.

## Impact

- `src/app/[collection]/llms-full.txt/route.ts` and `src/app/[collection]/[line]/llms-full.txt/route.ts` — the two routes that build a line corpus. Each gains the contents block ahead of the page text.
- `src/lib/artifacts.ts` — where the block is composed, so the two routes and the site-wide one agree on its shape rather than each writing their own.
- `src/app/llms-full.txt/route.ts` — adopts the shared composer, so the block that already exists there stops being a second implementation of the same thing.
- `scripts/check-artifacts.ts` — gains the assertion that every corpus declares its scope.
- The corpora themselves grow by a handful of lines each. No page text changes, no URL moves, and the cascade's shape is untouched.
