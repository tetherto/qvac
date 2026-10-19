## Context

An icon reaches a rendered surface as a string, and the site has two resolvers that turn such a string into an element.

`source.ts` configures Fumadocs' own `icon` hook. It reads Lucide's set plus a small `brandIcons` allowlist — `SiElectron`, `SiExpo` today — and it is what resolves the icon of a page or folder declared in frontmatter or `meta.json`. This is the sidebar's path.

`src/lib/resolveIcon.ts` is a second resolver that reads Lucide alone. It is what `custom-tree.ts` uses for the two hand-declared collections, and what `page.tsx` uses to build the title icon. The two disagree: a brand mark that the sidebar resolves is invisible to `resolveIcon`, which returns `undefined` for anything Lucide does not carry.

Before the navigation moved into `meta.json`, no page carried an `icon` in its frontmatter — 43 icons were declared beside sidebar entries in `custom-tree.ts` and read by nothing else. Today 100 pages carry one, and `page.tsx` renders each in the `<h1>`. The title icon was never a decision; it is code that existed in `main` unchanged and had no input until now.

## Goals / Non-Goals

**Goals:**

- Take the icon out of the `<h1>` on every page.
- Restore the five icons the conversion dropped, in every line carrying the page.
- Write down where an icon may be declared and which surfaces render it, so the next person does not have to read two resolvers to find out.

**Non-Goals:**

- Collapsing the two resolvers into one. They serve different declaration sites and the duplication is narrow; merging them is worth its own change.
- Auditing the other 95 icons. The five are the ones a reader can see missing against `main`.
- Any change to the Ecosystem or Resources sidebars, which belong to `restructure-ecosystem-and-resources`.

## Decisions

### The title icon is removed, not made opt-in

The obvious alternative is a frontmatter flag letting a page ask for its icon in the title. It was rejected: the icon's job is to tell pages apart in a list, and there is no page for which repeating it above the title earns its space. A flag would add a knob nobody has asked to turn and a second way for the two surfaces to drift.

Removing it also retires `page.tsx`'s use of `resolveIcon`, which leaves the weaker of the two resolvers serving only `custom-tree.ts`, where every icon is Lucide by construction.

### The two brand marks join the allowlist that already exists

`SiTypescript` and `SiPython` are added to `brandIcons` in `source.ts`. The allowlist is already the documented answer to "an icon the tree names, beyond Lucide's set", and it already carries two entries for exactly this reason. Nothing new is invented, and the comment above it stays true.

Importing the whole of `@icons-pack/react-simple-icons` was rejected: the allowlist is what keeps the icon set a decision rather than a dependency's surface area.

### The icons are restored in every line that carries the page

A page's identity in the sidebar should not change when a reader switches line. All three SDK lines carry these five pages, so all three get the frontmatter field. This is ordinary line editing, which the release workflow already sanctions.

### Ordering against the other change

This change and `restructure-ecosystem-and-resources` touch disjoint files and can land in either order. The only shared surface is the frontmatter of pages that the other change moves, and an `icon` field travels with the file.

## Risks / Trade-offs

- **Removing the title icon is a visible change on 100 pages.** → It restores what `main` and production show today, so the change is toward the familiar rather than away from it.
- **A future brand icon fails silently.** → An unresolvable string returns `undefined` and the entry simply renders without an icon, which is how the five went missing unnoticed. Out of scope to fix here, but it is the reason this change specifies the declaration site rather than only patching the five.
- **The two resolvers remain.** → Accepted and recorded, with `page.tsx` no longer among the callers, so the weaker resolver's blind spot can no longer affect a page's title.
