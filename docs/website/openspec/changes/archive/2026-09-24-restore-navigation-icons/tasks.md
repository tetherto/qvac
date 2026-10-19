## 1. Take the icon out of the page heading

- [x] 1.1 Remove the `titleIcon` span from `<DocsTitle>` in `src/app/(docs)/[[...slug]]/page.tsx`, leaving the title text.
- [x] 1.2 Remove the now-unused `rawIcon`/`titleIcon` resolution and the imports it alone needed — `resolveIcon`, `isValidElement`, `cloneElement`.
- [x] 1.3 Confirm no other component renders `page.data.icon` beside a heading.

## 2. Extend the brand-icon allowlist

- [x] 2.1 Add `SiTypescript` and `SiPython` to `brandIcons` in `src/lib/source.ts`, importing them from the package the existing two come from.
- [x] 2.2 Leave `src/lib/resolveIcon.ts` as it is: after task 1 it serves only `custom-tree.ts`, where every icon is Lucide.

## 3. Give the five pages their icon back

- [x] 3.1 Add `icon: SiTypescript` to `js-ts-sdk.mdx` and `icon: SiPython` to `python-sdk.mdx`, in all three SDK lines.
- [x] 3.2 Add `icon: MemoryStick` to `models/assess-model-fit.mdx`, in all three SDK lines.
- [x] 3.3 Add `icon: Music` to `ai-capabilities/music-generation.mdx` and `icon: Rotate3d` to `ai-capabilities/world-simulation.mdx`, in all three SDK lines.
- [x] 3.4 Re-run the comparison against `main`'s former tree and confirm no entry that had an icon is still without one.
- [x] 3.5 Give the HTTP-server folder its `Server` icon back, in the `meta.json` of all three CLI lines. A folder takes its icon from its own `meta.json`, never from its index page, so this one survived the first pass.

## 4. Verify

- [x] 4.1 Run `npm test`.
- [x] 4.2 Run `npm run build` and confirm it succeeds.
- [x] 4.3 Open a built page that declares an icon and confirm its heading shows the title alone.
- [x] 4.4 Open the SDK sidebar in each of the three lines and confirm the five entries carry their icons, the two client pages with their language marks.

## 5. Land

- [x] 5.1 Run `openspec validate restore-navigation-icons --strict` and archive the change.
- [x] 5.2 Write the Purpose preamble of `openspec/specs/docs-icons/spec.md`, which the archive leaves as `TBD`.
- [x] 5.3 Commit the whole change as one commit.
