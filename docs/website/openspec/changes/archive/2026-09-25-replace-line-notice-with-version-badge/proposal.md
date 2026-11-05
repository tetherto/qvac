## Why

Every page of a versioned collection opens with an injected sentence: *"Applies to `@qvac/sdk` v0.20, the release this documentation currently describes."* It was put there because version applicability has to survive a page being read apart from the site, and at the time the page's prose was the only place that guaranteed it.

It is no longer the only place, and it was never a good one. The sentence sits above the first paragraph of all 110 versioned pages, in italics, saying the same thing on every one of them — the reader learns it once and then reads past it 109 times. It pushes the page's actual opening down. And it states in a full sentence what a reader wants at a glance: which release this is, and whether it is the current one.

Meanwhile the machine-readable statement the sentence was standing in for now exists on both surfaces that matter, gated on every build. The page's Markdown twin declares `package`, `line`, and `current_line` in its front matter, and every page inside every corpus carries that same front matter. The rendered page declares the same three as `inkeep:` meta tags. An agent handed either representation can already tell which release it holds, without reading a word of prose.

What is left unserved is the reader, glancing. A label states the release where the eye already is — the line above the heading, where the page says where it sits — and states by colour the one thing the sentence spent a clause on: whether this is the release currently shipping.

## What Changes

- The injected sentence is removed. Nothing is written into a page's prose to state its release.
- A label on the breadcrumb row, aligned right, states the documentation line a page belongs to.
- The label is emphasised in the brand colour on the current line and drawn neutrally on every past line, so a reader on outdated documentation sees it without reading.
- A page of a collection that publishes no documentation lines carries no label, and neither does an inventory page, which catalogues a release rather than documenting a line.
- The label carries its own name in words for a reader who cannot see the colour, and is a statement rather than a control — the line switcher in the sidebar remains the only way to change lines.
- No change to the page metadata, which already states all of this and is already gated.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `versioned-agent-artifacts`: the requirement that a published page state its line in its rendered output stands, with the prose no longer the place it is stated. The guarantee for a page read apart from the site moves entirely onto the page's Markdown, which is what the copy control copies and what every corpus concatenates.
- `version-navigation`: gains the label as a second reader-facing surface for the documentation line, beside the switcher. The switcher says which line the reader is on and changes it; the label says which line the page is, wherever the page is read from.

## Impact

- `source.config.ts` and `src/lib/remark-line-notice.ts` — the remark plugin that injects the sentence is removed.
- `src/components/page-breadcrumb.tsx` — becomes the whole breadcrumb row, holding the trail and the label, since a versioned index page carries a label with no trail beside it.
- `scripts/check-breadcrumbs.ts` — extended to assert the label, because the label and the trail share a row and a gate that located that row twice would eventually disagree with itself.
- Every versioned page's rendered output and Markdown twin lose one paragraph. No URL changes, no metadata changes, no change to the sidebar, the switcher, or the collection bar.
