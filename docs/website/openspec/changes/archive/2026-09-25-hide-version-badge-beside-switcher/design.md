## Context

The sidebar is not hidden by the sidebar element. `<aside id="nd-sidebar">` carries no responsive class at all; its placeholder does:

```
<div data-sidebar-placeholder class="... md:layout:[--fd-sidebar-width:268px] max-md:hidden ...">
```

`max-md:hidden` compiles to `@media not all and (min-width:48rem)`, so the sidebar and everything in it — including the line switcher, which the layout passes into the sidebar's `banner` slot — are absent below 768px and present at and above it.

That is a Fumadocs decision, taken in a third-party layout, and the label now has to be the exact complement of it. Two independent declarations of "768px" would be correct today and wrong the day the framework moves its own.

The sidebar can also be hidden above the breakpoint: the layout renders a *Collapse Sidebar* button, and the aside carries `data-collapsed`. In that state the switcher is off screen while the viewport is wide, and `useSidebar()` exposes `collapsed` for anything that wants to follow it.

## Goals / Non-Goals

**Goals:**

- Show the label only where the switcher is not shown.
- Bind the label to the sidebar's breakpoint rather than to a copy of its value.
- Make a framework change to that breakpoint fail the build.

**Non-Goals:**

- Following the sidebar's collapsed state. See below.
- Any change to what the label says, how it is coloured, or what it announces.
- Any change to the trail, which is not redundant with anything in the sidebar — the sidebar shows where a page sits within one collection, and says nothing about the path down to it.

## Decisions

### Viewport only, not the collapsed state

Collapsing the sidebar on a wide viewport hides the switcher too, so by the rule as stated the label should return. It will not.

Collapsing is a deliberate act by a reader who has decided they want the width more than the chrome, it is reversible by hovering the edge, and it persists across pages. Bringing a badge back in response would hand back a slice of the chrome the reader just dismissed. It would also mean the label's visibility is decided in two places at once — a media query and a React context — with the second only knowable after hydration, so the label would appear a frame late for the readers who chose that state.

The cost is that a collapsed-sidebar reader sees no release anywhere on the page. They opted into that, and one hover restores it.

### The breakpoint is read from the sidebar, not restated

`md:hidden` is what the label carries, and it is correct only because the sidebar carries `max-md:hidden`. Nothing in the code says so, and nothing would notice if the framework moved the sidebar to `lg`: the label would keep hiding itself at 768px and a tablet reader would see neither the switcher nor the label.

So the gate derives the truth rather than asserting a constant. It finds the sidebar placeholder in the built page, reads whichever `max-<breakpoint>:hidden` it carries, and requires the label to carry `<breakpoint>:hidden` — the same token, the complementary direction. A framework change to the sidebar's breakpoint then fails the build naming both classes, which is the only way this coupling can be maintained rather than merely documented.

### The label stays in the HTML

Hiding is `display: none`, not conditional rendering. Rendering it conditionally is impossible without knowing the viewport, which is not knowable at build time for a statically exported page, and approximating it after hydration would flash.

A consequence worth stating: the label's text remains in the page's HTML at every viewport, so anything reading the page as text still finds the release and its standing. That is the guarantee the removed prose sentence used to carry, and it survives this change untouched.

### The row's emptiness test now ignores the label

The row renders nothing when it has neither trail nor label. With the label hidden above the breakpoint, a collection index on a wide viewport has a row containing only a hidden element — an empty flex container with a gap, above the heading.

Tailwind's `empty:hidden` does not help, since the container is not empty, it holds a hidden child. So the row applies the same responsive condition to itself when the trail is absent: no trail and a label means the row exists exactly where the label does.

## Risks / Trade-offs

**A reader on a wide viewport with the sidebar collapsed sees no release** → Accepted, as above. The alternative costs a hydration-dependent second source of truth to serve a state the reader chose.

**The label is markup that most readers never see** → One span per page, already rendered, now with one more class. It is also what keeps the release in the page's text at every viewport, which is worth more than the bytes.

**The gate depends on a `data-` attribute of a third-party layout** → If Fumadocs renames `data-sidebar-placeholder`, the gate fails to find the sidebar. That is the correct outcome: it fails loudly rather than passing on an assumption it can no longer verify, and the message says what it looked for.
