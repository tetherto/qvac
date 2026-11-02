## Why

The release label was added an hour ago, and on a wide viewport it states something already on screen. The first thing in the sidebar is the line switcher, which names the line the reader is on. The label names the same line, a few centimetres to the right. A reader on `/sdk/v0.18` is told `v0.18` twice, in two places, at the same moment.

Below `md` the sidebar is not rendered at all, and the switcher goes with it. That is the viewport where nothing on screen says which release the page describes — and it is also the viewport where a reader is most likely to have arrived from a search result, with the least context about where they landed.

So the label is redundant exactly where the sidebar is, and load-bearing exactly where it is not. It should appear only in the second case.

## What Changes

- The release label is hidden at the viewports where the sidebar is rendered, and shown at the viewports where it is not.
- The breakpoint is the sidebar's own. The label is not given a breakpoint of its own to keep in step with it.
- Where the label is hidden, its row is unchanged otherwise: a page with a trail still shows the trail, and a page with neither — which is now every collection index on a wide viewport — shows no row.
- The label's content, colours, and accessible text are unchanged. Nothing changes for a reader below the breakpoint.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `version-navigation`: the requirement placing the label on the breadcrumb row gains the condition that it appears only where the switcher does not, and the requirement gating the row gains the assertion that the two agree about where that is. The label's content, its two treatments, and its being a statement rather than a control are untouched.

## Impact

- `src/components/breadcrumb-row.tsx` — the label carries a responsive class, and the row's emptiness test accounts for a label that is present in the markup but not displayed.
- `scripts/check-breadcrumb-row.ts` — reads the sidebar's breakpoint out of the built page and requires the label to carry its exact complement, so a framework change to the sidebar's breakpoint fails the build instead of silently leaving the label wrong on one band of viewports.
- No change to any page's content, metadata, URL, or Markdown. The label remains in the HTML of every versioned page; only its display changes.
