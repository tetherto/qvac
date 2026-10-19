## Context

Seven corpora ship. One is site-wide, at `/llms-full.txt`; six are line-scoped, one per documentation line of the SDK and CLI. All seven are built the same way — resolve a page set, drop the release notes, concatenate `getLLMText` over the rest — by three routes that each spell the pipeline out for themselves.

Only the site-wide one introduces itself. Its route composes a header naming what it carries, what it excludes, and where the excluded lines' corpora are. The two line routes return `texts.join('\n\n')` and nothing more, so a line corpus begins mid-stream, on the frontmatter of whichever page sorts first.

The release-notes exclusion is the same in all three, drawn from the same `isReleaseNotesPage` predicate, and it is stated in all three route comments. It reaches a reader in exactly one of the seven artifacts.

The gap shows at the seam between the index and the corpus. A line index counts its pages — `Total pages: 36` for each SDK line — and points at the corpus as "Full text of this line in one fetch". The corpus holds 35. The difference is one page in three, and nothing in either artifact accounts for it.

The published requirement takes the line routes at face value: a line corpus holds "the full text of that line's pages and nothing else". Neither half is true. The exclusion removes a page the line publishes, and the block this change adds is not page text.

## Goals / Non-Goals

**Goals:**

- Let an agent holding only a corpus tell which line it is reading and what was withheld from it.
- Close the count gap between a line index and the corpus it names, by accounting for it rather than by removing it.
- State the exclusion in the spec, so the requirement describes the artifact that ships.
- Compose the block once, so the seventh corpus and the first six cannot drift apart.

**Non-Goals:**

- Reversing the exclusion. QVAC-21379 settled that a changelog costs more tokens than it returns, and nothing here reopens it.
- Publishing a separate release-notes corpus. The pages are individually fetchable and listed in every index; a second corpus would be a second thing to keep isolated.
- Changing what a corpus contains beyond its opening block, or moving any artifact's URL.
- Making the block machine-parsed. `versions.json` is the machine-readable face of the hierarchy and already carries the structure; the block is prose for a reader that arrived with only the corpus.

## Decisions

### The block is composed once, in `src/lib/artifacts.ts`

The three routes already share `pagesOfLine`, `lineCorpusUrl`, `lineIndexUrl` and `isReleaseNotesPage` from that module; the header is the one part of the pipeline each writes alone, and it is the part that diverged. A `corpusHeader` beside the existing helpers makes the site-wide corpus and the six line corpora say the same thing in the same words, and makes the next corpus inherit the block instead of reimplementing it.

The alternative — copying the site-wide header into the two line routes — is three copies of a paragraph that must agree, which is how the divergence arose.

### The site-wide corpus adopts the shared composer rather than keeping its own

Its header is the one that is already right, so leaving it alone is tempting. But then the module has a composer used by six artifacts and a hand-written block in the seventh, and a future edit to the exclusion wording lands in one of the two. Folding it in costs a rewrite of a block that already works and removes the asymmetry that caused this change.

### A line corpus sends a reader to the resolver, never to a sibling line

A reader who fetched the wrong line needs the right one, and the corpus is where they discover they are on the wrong one. Naming the sibling corpora outright would save a round trip, and the site-wide corpus does exactly that — but it is not line-scoped, and a line corpus is. `versioned-agent-artifacts` forbids a line-scoped artifact from referencing another line's URL, and the build gate enforces it. The line index already meets this by pointing at `/{collection}/llms.txt` and `versions.json` instead of listing its siblings; the corpus follows it.

The cost is one extra fetch for a reader who guessed wrong. The alternative is an artifact that fails the gate the moment it is built, which is how this decision was reached: the first draft of the block listed the siblings, and writing the gate is what surfaced the conflict.

### The block states the count the corpus holds, not the count the line publishes

The index says `Total pages: 36` because the line has 36 pages, and that is the right number for an index — it lists all of them. The corpus says how many it carries and why the two differ. Making the index report 35 instead would misdescribe the index to fix the corpus, and an agent choosing a line off the index wants the line's size.

### The gate asserts the declaration, not its wording

`check-artifacts.ts` already opens every corpus to check isolation and resolve URLs. It gains one assertion: a corpus begins with a block that names its scope. Checking the exact sentences would make every wording improvement a test edit, and the failure this guards against is a corpus shipping with no block at all — which is what six of them do today.

## Risks / Trade-offs

**A prose block at the head of a machine-read artifact is text an agent must skip** → It is a handful of lines against corpora of two to twenty thousand, it is the shape `llms.txt` already established for the site-wide corpus, and the alternative is the silence this change exists to end.

**The block restates what `versions.json` holds structurally** → It does, for a reader who never fetched it. An agent that arrived through the hierarchy has the structure already and loses nothing; an agent handed a bare corpus gains the only orientation it will get.

**Folding the site-wide header into the shared composer risks changing an artifact that was not broken** → The change is verifiable by reading the built file, and the shared block is a superset of what it says today. The build's URL-resolution pass covers the links either way.

**Every corpus grows, and the site-wide one is fetched whole** → By under ten lines on a 33,000-line file. Below the noise of a single page.
