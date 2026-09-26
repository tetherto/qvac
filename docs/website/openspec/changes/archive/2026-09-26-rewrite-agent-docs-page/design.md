## Context

Five things on this site are addressed to an agent, and they were built separately:

- **`llms.txt`** at three levels — the root router naming the collections, a collection's resolver naming its lines, and a line's index listing its pages. `/{collection}/versions.json` is the resolver as JSON.
- **`llms-full.txt`** at the same three levels — the site corpus carrying the unversioned collections plus each versioned collection's current line, a collection's corpus carrying its current line, and a line's own. Each opens with a header stating its scope, its page count, and that release notes are withheld.
- **The assistant**, on `Cmd/Ctrl + I`, which restricts retrieval to the line the reader is in, the unversioned collections, and the current line of every other versioned collection.
- **Markdown**, reachable by appending `.md` to a page's path or by sending `Accept: text/markdown` to the page URL, which 303s to the Markdown. Its front matter states the collection, the tracked package, the line, whether that line is current, and the canonical URL. Each page also offers Copy page, Copy page as Markdown, Open in ChatGPT, and Open in Claude.
- **The MCP server** at `https://mcp.inkeep.com/tetherio/mcp`.

The page currently documents the first of these, as a procedure, and mentions Markdown in passing in a table.

## Goals / Non-Goals

**Goals:**

- Let a reader discover all five and use any one of them without leaving the page.
- Say, per resource, only what is needed to use it.
- Put the versioning caution where it applies: once, at the end, rather than threaded through every section.

**Non-Goals:**

- Explaining how any of it is built. A reader does not need to know that the corpora are generated at build time or that the line folders are parenthesised groups.
- Documenting MCP clients. Which editors speak MCP and how each is configured is their documentation's job, and it changes faster than this page would be revised.
- Replacing `/llms.txt`'s own guidance. The root index carries short instructions of its own for an agent that never reaches this page; this page is the longer form, and the two must agree rather than one absorbing the other.

## Decisions

### Five sections, each answering what it is and how to use it

The order is the order of the overview list, which is the order of increasing commitment: two files anyone can fetch, a chat, a fetch convention, then a server to configure.

Each section answers two questions — what the resource is for, and how to use it — and a third only where the answer is not obvious from the second: how the versioned collections change it. The MCP server has no third; neither does the assistant beyond a sentence, because it scopes itself. Writing an empty third part for symmetry would be the kind of filler the page exists to avoid.

### The reader is addressed directly, without separating the two audiences

The page is read by people and by agents, and splitting it — a procedure for agents, an aside for humans — makes both halves worse: the human half becomes a pointer elsewhere, and the agent half acquires a register no human wants to read.

So it says *you*. "Fetch this." "Do not mix lines." An instruction that works as an instruction works for both readers, and where the two genuinely diverge — an agent fetching `versions.json`, a person clicking the switcher — the sentence says which.

### Versioning is one section at the end, not a caveat in five places

Every resource is affected by lines, and repeating that in each section would be five variations of one idea. Stated once, at the end, it can be stated properly: what a line is, how to resolve one, what to do when none matches, and the rule against mixing.

The resource sections point forward to it where the interaction is not obvious — which corpus a collection's URL gives you, which line the assistant is searching.

### Cut everything not needed to use something

Applied as a pass after writing, per the brief: each unit of information is kept only if a reader needs it to use one of the five. This removes the build-time note, the explanation of why lines are self-contained, and the table of artifacts — the table restated in one grid what the sections say in prose, and a reader following a section does not need the grid.

What survives the pass and might look like background is the corpus scope header and the release-notes exclusion: both change what a reader gets from a fetch, so both are usage facts.

## Risks / Trade-offs

**A page describing five things is longer than one describing one** → It replaces five places a reader would otherwise have to find. Length is controlled by the cut pass rather than by covering less.

**Documenting behaviour rather than specifying it** → Everything the page describes already exists and is gated: the artifacts by `check-artifacts.ts`, the metadata by the retrieval tests, the menu by its two checks. The page can therefore go stale against the site, and no check would catch a paragraph that stopped being true. The mitigation is that the page cites addresses rather than describing shapes, and every address it cites is one the artifact check resolves.

**The MCP address appears in a third place** → The constant in the menu's module, the copy action, and now the page's prose. A page cannot import a constant, so this one is a literal. If the endpoint moves, the page is wrong; so is the menu, and neither fails a build, which is already recorded as accepted.
