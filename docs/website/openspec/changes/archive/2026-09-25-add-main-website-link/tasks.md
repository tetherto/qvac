## 1. Add the entry

- [x] 1.1 Import `FaGlobe` from `react-icons/fa6` in `src/app/(docs)/layout.tsx`, alongside the marks the bar already draws from there.
- [x] 1.2 Add the entry at the head of `linkItems`, ahead of the repository: `type: 'icon'`, `url: 'https://qvac.tether.io'`, the globe, `label` and `text` both naming the product's site, and `external: true`.

## 2. Bring the older entries up to the rule

- [x] 2.1 Give the repository entry a `label`, so its anchor stops rendering without an accessible name.
- [x] 2.2 Give the Discord entry a `label`, for the same reason.

## 3. Guard it

- [x] 3.1 Add a check asserting the bar's contract against the built navbar: the product's site is present, it leads the bar, and every anchor in the bar carries an accessible name. Place it where the site's other built-output assertions live — a post-build script in the build chain, beside `check-redirects.ts` and `check-artifacts.ts` — and let it fail if an entry is added without a name.
- [x] 3.2 Confirm the test fails when the new entry's `label` is removed, so it guards the requirement rather than the current text.

## 4. Verify

- [x] 4.1 Run `npm test` and confirm the suite passes, the new assertions included.
- [x] 4.2 Run `npm run build` and confirm it passes, with the broken-link check, both URL-fixture replays, and the artifact check clean.
- [x] 4.3 Read the built HTML: the globe's anchor targets `https://qvac.tether.io`, is first in the bar, opens in a new context, and every anchor in the bar — the two older ones included — carries an `aria-label`.
- [x] 4.4 Confirm the bar is unchanged in every collection and in an older documentation line, since it belongs to the site rather than to a line.

## 5. Land it

- [x] 5.1 Validate the change with `openspec validate add-main-website-link --strict` and archive it.
- [x] 5.2 Write the new spec's Purpose by hand, replacing the placeholder the archive leaves.
- [ ] 5.3 Commit the whole change as one commit.
