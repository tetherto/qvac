## 1. Remove the injected sentence

- [x] 1.1 Drop the line-notice plugin from the MDX pipeline in `source.config.ts` and delete the module that implements it.
- [x] 1.2 Confirm no page's Markdown twin and no corpus still carries the sentence.

## 2. Build the label

- [x] 2.1 Add a label component rendering the page's documentation line, resolved from the same derivation the page metadata uses, so the label and the metadata cannot disagree.
- [x] 2.2 Draw the current line in the brand colour and every past line in the neutral one.
- [x] 2.3 Append the standing as visually hidden text — the current release, or not the current release — so it is what assistive technology announces and what a text scrape keeps.
- [x] 2.4 Render nothing for a collection that publishes no documentation lines, and nothing for an inventory page.

## 3. Put it on the row

- [x] 3.1 Rename the breadcrumb slot component to say it renders the row, and have it hold the trail on the left and the label pushed to the right.
- [x] 3.2 Render the row whenever either the trail or the label has content, and nothing when neither does.

## 4. Guard it

- [x] 4.1 Extend the built-output check that already parses this row to assert the label: which pages carry one, which carry none, that it names the page's own line, that the two treatments differ, and that the standing is present as text. Rename the check for what it now covers.
- [x] 4.2 Add the one assertion outside the row: no versioned page's Markdown states its release in its prose.
- [x] 4.3 Confirm the check fails when a label names another line, when an unversioned page is given one, and when the sentence is put back.

## 5. Verify

- [x] 5.1 Run `npm test` and confirm the suite passes.
- [x] 5.2 Run `npm run build` and confirm every check passes.
- [x] 5.3 Read the built rows across all four collections: a page deep in a line, a collection index, a line index, an unversioned page, an inventory version page.
- [x] 5.4 Confirm a versioned page's Markdown twin still states its line in front matter and no longer states it in prose.
- [x] 5.5 Confirm the page metadata is untouched: the same `inkeep:` tags and the same front matter as before the change.

## 6. Land it

- [x] 6.1 Validate the change with `openspec validate replace-line-notice-with-version-badge --strict` and archive it.
- [x] 6.2 Check both published specs after archiving, and give `version-navigation` the purpose it has been missing.
- [x] 6.3 Commit the whole change as one commit.
