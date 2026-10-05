## 1. Move Tutorials and Help out of the SDK lines

- [x] 1.1 `git mv` the three copies of `content/docs/sdk/<line>/tutorials/` into one `content/docs/resources/tutorials/`, keeping `electron.mdx`, `expo.mdx`, and the section's `meta.json` title, and delete the two now-redundant copies.
- [x] 1.2 `git mv` one copy of `content/docs/sdk/<line>/troubleshooting.mdx` to `content/docs/resources/troubleshooting.mdx` and delete the other two.
- [x] 1.3 Drop `---Tutorials---`, `...tutorials`, `---Help---`, `troubleshooting`, and the Discord entry from the `meta.json` of all three SDK lines.
- [x] 1.4 Rewrite the six internal links that point at the moved pages — `/sdk/troubleshooting#…` in each line's `system-requirements.mdx`, `/sdk/tutorials/electron#…` in each line's `configuration/plugins/index.mdx` — to their `/resources/…` form.

## 2. Rename Corpus protocol to Build with AI

- [x] 2.1 `git mv content/docs/resources/corpus-protocol.mdx content/docs/resources/build-with-ai.mdx` and update its `title`.
- [x] 2.2 Confirm no rule for `/resources/corpus-protocol` is added, and that the address appears in neither URL fixture.
- [x] 2.3 Update any internal link to the old path.

## 3. Rewrite the Resources overview

- [x] 3.1 Rewrite the prose of `content/docs/resources/index.mdx` for the scope the collection now has: the tutorials, the help material, Build with AI, and the sample projects.
- [x] 3.2 Replace the "Main website" card with a Recipes card pointing at `https://qvac.tether.io/recipes`.

## 4. Declare the two sidebars

- [x] 4.1 Add whatever `custom-tree.ts` needs to declare a departure: the off-site form carrying `external: true`, and the cross-collection form written with its trailing slash, each with a comment stating why the slash is load-bearing.
- [x] 4.2 Rewrite `ecosystemChildren` as Overview, the vision departure, then the Products, Platform, and Research separators with their entries, per the Ecosystem sidebar requirement.
- [x] 4.3 Point the Products group's model-provider entry at `/cli/http-server/connection/`, the page documenting the CLI as a local model provider.
- [x] 4.4 Rewrite `resourcesChildren` as Overview, Build with AI, the tutorials, and the help material including the Discord departure.
- [x] 4.5 Collapse the two icon resolvers behind the one allowlist in `resolveIcon.ts`, so a hand-declared entry can name a brand mark. The tutorials carry the Electron and Expo marks, and Resources declares its navigation in the source, where only Lucide resolved. Reverses a non-goal of the design, agreed with the human when implementation hit it.
- [x] 4.6 Drop the now-inert `icon:` frontmatter from the Resources pages, which declare their icons in the source. A second declaration is what the icons spec forbids, and nothing else reads the field.

## 5. Guard the shadowing

- [x] 5.1 Add an assertion to `tests/sidebar-consistency.test.ts` that `/sdk`, `/cli`, and the model-provider page each resolve, via `searchPath`, to a chain whose last root is their own collection.
- [x] 5.2 Verify the assertion fails when a departure is rewritten without its trailing slash, then restore it.
- [x] 5.3 Confirm the existing gate still skips off-site entries and still checks the cross-collection ones.

## 6. Keep the moved addresses resolving

- [x] 6.1 Add one-hop `301` rules in `public/_redirects` for `/sdk/troubleshooting/`, `/sdk/tutorials/electron/`, `/sdk/tutorials/expo/`, and their `.md` twins.
- [x] 6.2 Retarget the pre-collections rules `/troubleshooting/`, `/tutorials/electron/`, `/tutorials/expo/` and their `.md` twins at the Resources addresses, so a years-old link still takes one hop.
- [x] 6.3 Add no rule for any `/sdk/v0.18/**` or `/sdk/v0.19/**` address of a moved page, and record why in the file's commentary.

## 7. Verify

- [x] 7.1 Run `npm test` and confirm the sidebar-consistency, link-integrity, and structure suites pass.
- [x] 7.2 Run `npm run build` and confirm the broken-link check, the redirect replay against both fixtures, and the artifacts check all pass.
- [x] 7.3 Walk the built Ecosystem sidebar and confirm each of the three groups renders its entries, the off-site ones as outbound links.
- [x] 7.4 Open `/sdk`, `/cli`, and the model-provider page in the built output and confirm each shows its own collection's sidebar and tab.

## 8. Land

- [x] 8.1 Run `openspec validate restructure-ecosystem-and-resources --strict` and archive the change.
- [x] 8.2 Write the Purpose preamble of any spec the archive leaves as `TBD`.
- [x] 8.3 Commit the whole change as one commit.
