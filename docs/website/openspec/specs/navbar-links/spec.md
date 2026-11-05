# navbar-links Specification

## Purpose

Governs the row of icon-only links in the top navbar — the site's outbound bar, leading to the product's own site and to the places the project is found. It owns what belongs in the bar, the order the product's home holds within it, the name every entry must carry for a reader who cannot see its glyph, and what an entry must declare when it leaves the documentation.

Distinct from `collection-navigation`, which governs movement between and within collections, and from `version-navigation`, which governs the line switcher. This bar leads out of the documentation entirely; those two move a reader around inside it.

## Requirements
### Requirement: The navbar carries a link bar of outbound destinations

The top navbar SHALL carry a bar of icon-only links to destinations outside the documentation. The bar MUST be present on every documentation page, in every collection and every documentation line, because it belongs to the site rather than to any part of it. Each entry MUST lead to one destination and MUST be rendered as its glyph alone, with no visible text beside it.

#### Scenario: The bar is present on every page

- **WHEN** a documentation page is rendered, in any collection and any line
- **THEN** the navbar carries the link bar
- **AND** the bar holds the same entries it holds on every other page

#### Scenario: An entry renders as a glyph

- **WHEN** the bar is rendered on a viewport wide enough for it
- **THEN** each entry is an anchor whose visible content is its icon and nothing else

### Requirement: The bar leads to the product's own site

The bar SHALL carry an entry leading to `https://qvac.tether.io`, the site that publishes the product this documentation documents. A reader who arrives on any page SHALL be able to reach the product from the page they landed on, without navigating the documentation first. The entry MUST be identified by a globe, which names a destination that is a website rather than a service with a mark of its own.

#### Scenario: The main website is reachable from any page

- **WHEN** a documentation page is rendered
- **THEN** the bar carries an entry whose destination is `https://qvac.tether.io`
- **AND** the entry renders a globe

#### Scenario: The entry opens the product's site

- **WHEN** the reader activates that entry
- **THEN** the product's site is opened, in a new context, leaving the documentation page where it was

### Requirement: The product's home precedes the places the project is found

The entry leading to the product's own site SHALL be ordered ahead of the entries leading to where the project can be found — its repository, its chat rooms, its model host, its announcements. The two kinds are not interchangeable: one is the subject of the documentation, the rest are places to encounter the people who make it. The ordering SHALL express that distinction rather than the order the entries happened to be added.

#### Scenario: The product's site leads the bar

- **WHEN** the bar is rendered
- **THEN** the entry for `https://qvac.tether.io` is the first of them
- **AND** the repository, chat, model-host, and announcement entries follow it

### Requirement: Every entry carries an accessible name

Each entry SHALL declare a name for a reader who cannot see its glyph, and that name MUST reach the rendered anchor as its accessible name. An icon-only anchor has no text content, so without it the link is announced as an address or as nothing. The entry SHALL also declare the label shown where the bar collapses into a menu on a viewport too narrow for a row of glyphs. Both are required of every entry, including those added before this requirement.

#### Scenario: Every anchor in the bar is named

- **WHEN** the built page is inspected
- **THEN** every anchor in the link bar carries an accessible name
- **AND** none of them relies on its address to be announced

#### Scenario: A collapsed bar names its entries

- **WHEN** the bar is rendered on a viewport too narrow for the row of glyphs
- **THEN** each entry is reachable from the control it collapses into
- **AND** each one is labelled there

#### Scenario: An entry added before the requirement is brought up to it

- **WHEN** an entry that predates this requirement is rendered
- **THEN** it carries an accessible name like every other entry

### Requirement: An entry that leaves the site declares that it does

An entry whose destination is another origin SHALL be declared as external, so it is rendered as a plain anchor that opens in a new context rather than as a client-side navigation into a route this site does not serve. An entry whose destination is this site — including one that opens an in-page surface rather than navigating — MUST NOT be declared external.

#### Scenario: An outbound entry opens away from the documentation

- **WHEN** an entry whose destination is another origin is rendered
- **THEN** its anchor targets a new browsing context and carries the corresponding relationship attributes

#### Scenario: An in-page entry stays in place

- **WHEN** an entry whose destination is a surface of this site is rendered
- **THEN** it is not marked external, and activating it does not open a new context

