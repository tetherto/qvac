## Context

The injected sentence comes from `remarkLineNotice`, a remark plugin registered in `source.config.ts`. It prepends one paragraph to every MDX file that sits inside a documentation line, derived from the folder the file is in. Because it runs on the MDX AST, it feeds both renderings of a page: the HTML and the Markdown twin, and therefore every corpus, which concatenates twins.

Its justification is recorded in `versioned-agent-artifacts`: *"Version applicability SHALL survive copy-paste. Every page of a versioned collection MUST state its documentation line in the rendered content, so an agent given only the text can tell which release it applies to."* That requirement was written before the page metadata existed. The metadata now exists on both surfaces and is gated on every build:

- The Markdown twin's front matter carries `collection`, `package`, `line`, `current_line`, and the canonical URL. `check-artifacts.ts` verifies all 151 pages against their route.
- The rendered HTML carries `inkeep:collection`, `inkeep:package`, `inkeep:line`, `inkeep:current_line`. `tests/retrieval-filter.test.ts` covers them, and `versioned-search` requires them.

So the sentence is the third statement of a fact already stated twice, and the only one a reader has to read.

The reader-facing gap is different in kind. The sidebar switcher names the line, but it is a control in the chrome, some distance from the content. A reader who lands on a page from a search result reads the heading first. What they are not told, at that point, is whether the page describes the release currently shipping.

An earlier design considered a badge and chose the sentence over it, on the grounds that the sentence survives copy-paste and chrome does not. That reasoning held when the front matter did not exist. It no longer does: the copy control copies the Markdown, front matter included.

## Goals / Non-Goals

**Goals:**

- State the release at a glance, where the reader's eye already is.
- Make an outdated page visibly outdated without requiring the reader to know the release list.
- Take a paragraph off the top of 110 pages.
- Keep the machine-readable guarantee exactly as strong as it is today.

**Non-Goals:**

- Changing any metadata. Every attribute this concerns is already published and already gated.
- Making the label a control. The switcher is the control, and duplicating it in the content area would give two answers to "how do I change version".
- Labelling inventory pages. `pageAttributes` already draws the distinction — an inventory entry catalogues a package release page by page and is not a documentation line, and retrieval must not scope a reader to one.
- A label on unversioned collections. Ecosystem and Resources publish no lines; a label there would have nothing to say.

## Decisions

### The label reads the version alone

`v0.20`, not `@qvac/sdk v0.20` and not `Version v0.20`. On every page that has a trail, the collection is named immediately to the left, so the package is already on the row. On the index pages that have no trail, the collection bar and the sidebar both name it.

The rejected alternative worth naming is `v0.20 (latest)`, which says in words what the colour says. It was rejected for the visible label and adopted for the accessible one — see below — so the width cost is paid only where the colour cannot be seen.

### The standing is carried by colour and, in words, by the accessible name

The current line is drawn in the brand colour, a tint of `--color-fd-primary`; every past line is drawn in `fd-muted`. That is the whole visual distinction, and colour alone cannot carry meaning: a reader who cannot distinguish the two is shown `v0.18` and has no way to know it is not current, because the version number alone does not say so.

So the label appends a visually hidden clause to its text — *", the current release"* or *", not the current release"*. It costs no width, it is what a screen reader announces, and it is real text in the rendered HTML, so an agent scraping the page keeps the statement the removed sentence used to make.

### The badge is a statement, not a link

An outdated badge that led to the current page is a real pattern and was considered. It was rejected because the switcher already does exactly that, sits a few centimetres away, and handles the case this would not: a page that does not exist in the target line. Two controls for one action, one of which silently misbehaves in a case the other handles, is worse than one.

### The breadcrumb slot becomes the whole row

`DocsPage` has one slot on this row, the breadcrumb. The label has to appear on `/sdk` and `/sdk/v0.18`, which render no trail, so the label cannot hang off the trail's own rendering.

The slot therefore renders the row: the trail on the left when there is one, the label pushed right with `ms-auto`, and nothing at all when neither has content — which is every index page of an unversioned collection. The component is renamed from `PageBreadcrumb` to `BreadcrumbRow` to say so.

The alternative was rendering the label inside the page body, from the MDX pipeline. That is where the sentence lives today and it is the wrong place: it would put chrome into the content, which is what the corpora concatenate, and the removal is largely about getting it out of there.

### One gate for the row

`check-breadcrumbs.ts` already locates the row in the built HTML and parses it. The label assertions go into the same file rather than a new one, because two checkers each finding "the row" by their own rule would eventually disagree about which element it is, and the disagreement would surface as one of them silently passing.

It is renamed `check-breadcrumb-row.ts` to match what it now asserts, and gains one assertion outside the row: that a versioned page's Markdown twin no longer carries the injected sentence. That is the only guard on the removal, and it is one line.

## Risks / Trade-offs

**A reader who copies prose out of the browser loses the release** → This is the guarantee the sentence existed for, and it is the one thing genuinely given up. What replaces it: the copy control copies the Markdown twin, front matter included, and that is the path the page's own affordance offers. A hand-made text selection that starts below the heading loses it — as it already loses the title, the canonical URL, and the collection.

**Colour as the primary carrier of "outdated"** → Mitigated by the hidden clause, which is what assistive technology reads, but the mitigation is invisible to a sighted reader with low colour discrimination who sees a grey pill and no words. Accepted because the version number itself is the label's content and a reader who is on `/sdk/v0.18` reached it through a switcher that said so.

**A component that is called a breadcrumb slot and renders more than a breadcrumb** → Contained by naming it for the row rather than the trail. The framework's slot name stays `breadcrumb` because that is the framework's; ours says `BreadcrumbRow`.

**110 pages change in the same commit as a UI change** → The page changes are a deletion with no authored content touched: the paragraph was injected at build, never written into a file. No `.mdx` file is edited by this change.
