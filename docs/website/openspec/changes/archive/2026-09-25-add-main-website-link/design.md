## Context

The navbar's link bar is the `linkItems` array in `src/app/(docs)/layout.tsx`, passed to Fumadocs' `DocsLayout` as `links`. It holds five entries of type `icon`, each a component rendered into an icon-only anchor: the repository and Discord from `react-icons/fa6`, Keet from a local component, Hugging Face from `@icons-pack/react-simple-icons`, and X from `react-icons/fa6` again.

Four of the five leave the site and carry `external: true`. Keet is the exception: its URL is `#keet-room`, an in-page anchor that opens a modal mounted beside the layout, so it is not a departure at all.

The bar is unowned. Searching the published specs for it finds two mentions, neither of which governs it. `version-navigation` requires the navbar to survive a line switch without remounting. `collection-navigation` names its contents once, in a scenario establishing what the collection bar sits below — and that scenario lists two items the bar has never had.

Fumadocs' `IconItemType` distinguishes two strings. `text` is the label shown where the bar collapses into a menu; `label` becomes the anchor's `aria-label`. For an icon-only control the second is the only accessible name there is, because the anchor's sole child is an SVG. The three entries added most recently set both. The repository and Discord entries set only `text`, and render an anchor with no accessible name.

## Goals / Non-Goals

**Goals:**

- Reach the product's own site from any documentation page.
- Own the bar in a spec, so the next entry is added against a stated rule rather than by imitation.
- Leave every entry with an accessible name.

**Non-Goals:**

- The "For AI" entry. It is coming, and the spec is written to admit it without being rewritten.
- Reworking the bar's layout, ordering beyond the one placement this change decides, or its responsive collapse.
- Touching `collection-navigation`. Its scenario becomes half true here; the other half is the For AI change's to settle.
- Extending the `resolveIcon` allowlist. That mechanism resolves string-named icons for navigation entries; this bar passes components, and always has.

## Decisions

### The globe comes from `react-icons/fa6`, not Lucide

`FaGlobe` sits beside `FaGithub`, `FaDiscord` and `FaXTwitter` — three of the five entries already come from that family, and it is the filled, heavier style the bar reads in. Lucide's `Globe` is the site's sidebar family, but it is a thin outline stroke: next to a solid GitHub mark it would look like a different weight class rather than a sibling.

Both packages are already dependencies, so neither choice adds one. The decision is purely about which of the two the bar already looks like.

### The entry goes first, ahead of the repository

The five existing entries are all places the project can be found: its code, its two chat rooms, its models, its announcements. The product's own site is not one of those — it is what the documentation documents. Leading with it reads as "the product, then where to find us", where appending it would read as a sixth social link.

The alternative, appending after X, was rejected for that reason and not because of ordering cost: the array is hand-written and any position is one line.

### The bar gets its own spec rather than a requirement bolted onto `collection-navigation`

`collection-navigation`'s purpose is how a reader moves between and within collections — the collection bar, the sidebar, and the gate that validates navigation against content. The top navbar's outbound links are a different subject that happens to sit above it. Adding a requirement there would widen a purpose that is currently precise.

A new capability for one entry is only worth it if it keeps earning. It does: the For AI entry lands in the same array, and the accessible-name rule below applies to every entry the bar will ever have.

### Every entry carries an accessible name, including the two that predate the rule

Requiring `label` and leaving the repository and Discord entries without one would write a rule the code breaks the day it is published. Those two are two lines, verifiable in the built HTML — `aria-label` is either on the anchor or it is not — so there is no reason to grandfather them.

This also settles what the two strings are for, which imitation had left ambiguous: `text` names the entry in the collapsed menu, `label` names it for a reader who cannot see the glyph. Both are required, and for these entries they say the same thing.

### The guard reads the built HTML, not the declaration

The requirement is about the anchor a reader reaches, and `label` reaching `aria-label` is Fumadocs' behaviour rather than ours. A unit test over the array would assert our input and pass even if a Fumadocs upgrade stopped forwarding the string — the exact failure worth catching, since it is silent.

Reading the build also costs nothing structurally. `linkItems` is a local inside a server component, so a unit test would first have to lift it into a module; the build output needs no such rearrangement. The site already has two post-build checkers for properties that break silently, `check-redirects.ts` and `check-artifacts.ts`, and this is a third of the same kind.

The price is that the check runs in `npm run build`, not `npm test`, so it is minutes behind rather than seconds. For chrome that changes a few times a year, that is the cheaper side of the trade.

## Risks / Trade-offs

**A new capability spec for a single link reads as overhead** → It is one requirement set over a surface that already has a known next change. The alternative — stretching `collection-navigation` — trades a precise purpose for a vague one, which is the more expensive of the two.

**Adding `label` to two existing entries is scope the request did not ask for** → It is the direct consequence of the requirement being written, it is two lines, and it is asserted by the same test as the new entry. Left out, the spec ships already violated.

**The link is external, so no build gate resolves it** → True of the five entries already there, and of every `offSite` entry in the Ecosystem sidebar. The address is the product's own origin, already written in `custom-tree.ts` four times with a path on it; a typo in the bare origin would be visible on the first page load rather than silent.

**The bar grows, and on a narrow viewport a sixth icon competes for width** → Fumadocs already collapses the bar into a menu below its breakpoint, and `text` is what the collapsed form renders. The new entry sets it, so it degrades the same way the other five do. Worth a look during verification rather than a mechanism.
