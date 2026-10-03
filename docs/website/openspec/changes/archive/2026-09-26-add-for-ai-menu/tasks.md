## 1. Rename the protocol page

- [x] 1.1 Rename the Resources page's file, title, and description to name it as documentation for AI agents.
- [x] 1.2 Move the constant that holds its URL, so every corpus header and line index cites the new address with no other edit.
- [x] 1.3 Update the page's sidebar entry and the two tests that name the old URL.
- [x] 1.4 Confirm no redirect is needed, by checking the page's old URL against the production inventory.

## 2. Build the menu

- [x] 2.1 Add a navbar menu holding the four entries in order: the MCP server, the resolver index, the full corpus, the page on using the documentation with agents.
- [x] 2.2 Have the MCP entry write the server's address to the clipboard and acknowledge it, following the shape the page's copy control already uses, and carry no link.
- [x] 2.3 Place the menu beside the AI assistant in the navbar.

## 3. Guard it

- [x] 3.1 Declare the entries as data in one module, and assert their shape against that declaration: the entries and their order, the MCP entry with no URL, the page entry carrying the constant the artifacts cite.
- [x] 3.2 Extend the navbar check to assert the menu's trigger, in every rendering of the navbar on every page it samples, and that each is a control rather than a link.
- [x] 3.3 Confirm both fail: the declaration when an entry is removed or the MCP entry is given a URL, and the built-output check when the menu is absent or a trigger is made a link.

## 4. Verify

- [x] 4.1 Run `npm test` and confirm the suite passes.
- [x] 4.2 Run `npm run build` and confirm every check passes, including the artifact check that resolves every published URL.
- [x] 4.3 Confirm no published artifact still cites the page's former address.
- [x] 4.4 Read the built menu and confirm its four entries and their targets.

## 5. Land it

- [x] 5.1 Validate the change with `openspec validate add-for-ai-menu --strict` and archive it.
- [x] 5.2 Write the new capability's purpose after archiving, which the archive leaves as a placeholder.
- [x] 5.3 Commit the whole change as one commit.
