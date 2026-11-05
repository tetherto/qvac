## 1. Hide the label beside the switcher

- [x] 1.1 Give the label the condition that hides it at the viewports where the sidebar is rendered, using the sidebar's own breakpoint.
- [x] 1.2 Apply the same condition to the row itself when the row holds nothing but the label, so a collection index shows no empty row above its heading.
- [x] 1.3 Leave the label's text, treatments, and hidden standing untouched.

## 2. Guard the coupling

- [x] 2.1 Have the built-output check read the sidebar's breakpoint out of the page it is checking, rather than carrying the value.
- [x] 2.2 Require every label to be hidden at exactly the sidebar's viewports and shown at every other, and fail naming both classes when they disagree.
- [x] 2.3 Confirm the check fails when the label loses its condition, and when the label and the sidebar are given different breakpoints.

## 3. Verify

- [x] 3.1 Run `npm test` and confirm the suite passes.
- [x] 3.2 Run `npm run build` and confirm every check passes.
- [x] 3.3 Read the built markup of a versioned page, a versioned index, and an unversioned page, and confirm the label is present and conditioned where it should be.
- [x] 3.4 Confirm the release and its standing are still in the page's text at every viewport.

## 4. Land it

- [x] 4.1 Validate the change with `openspec validate hide-version-badge-beside-switcher --strict` and archive it.
- [x] 4.2 Check the published `version-navigation` spec after archiving.
- [x] 4.3 Commit the whole change as one commit.
