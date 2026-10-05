## 1. Compose the block once

- [x] 1.1 Add a corpus-header composer to `src/lib/artifacts.ts`, beside the helpers the three corpus routes already share, producing the block for either shape: a line corpus or the site-wide one.
- [x] 1.2 Have it state, for a line corpus: the collection and line, the package and release those track, whether the line is current, the number of pages carried, the line index URL, and a route to another line through the collection resolver and versions.json — never another line's URL, which the leakage gate forbids.
- [x] 1.3 Have it state, for either shape: that release notes are excluded, and the path pattern to fetch one as its own page.

## 2. Put it at the head of every corpus

- [x] 2.1 Emit the block ahead of the page text in `src/app/[collection]/llms-full.txt/route.ts`, the current line's corpus.
- [x] 2.2 Emit it in `src/app/[collection]/[line]/llms-full.txt/route.ts`, an older line's corpus.
- [x] 2.3 Replace the hand-written header in `src/app/llms-full.txt/route.ts` with the shared composer, so the site-wide corpus stops being a second implementation of the same block.

## 3. Guard it

- [x] 3.1 Extend `scripts/check-artifacts.ts` to require every corpus it opens to begin with a scope declaration, failing and naming the corpus otherwise.
- [x] 3.2 Confirm the gate fails when the block is stripped from one corpus, so it guards the requirement rather than the current text.

## 4. Verify

- [x] 4.1 Run `npm test` and confirm the suite passes.
- [x] 4.2 Run `npm run build` and confirm it passes, with the broken-link check, both URL-fixture replays, the artifact check, and the navbar check clean.
- [x] 4.3 Read the head of all seven built corpora and confirm each names its own scope, and that the six line corpora name the right line.
- [x] 4.4 Confirm every URL the new blocks introduce resolves in the build, and that no block names a line other than its own collection's.
- [x] 4.5 Confirm the page counts the blocks state match the pages each corpus actually carries, and that each accounts for the gap against its index's total.
- [x] 4.6 Re-walk the cascade from `/llms.txt` to every line's pages and confirm it is unbroken.

## 5. Land it

- [ ] 5.1 Validate the change with `openspec validate declare-corpus-scope --strict` and archive it.
- [ ] 5.2 Check the published spec after archiving, since the modified requirement replaces an existing one.
- [ ] 5.3 Commit the whole change as one commit.
