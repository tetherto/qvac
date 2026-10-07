## ADDED Requirements

### Requirement: The collection rename reclaims addresses instead of redirecting them

The rename SHALL cost no reader a URL, and SHALL add no redirect for an address no reader was ever served. `/provider/**` and `/sdk/cli` exist only on the unreleased branch, so the rename retires them outright: a rule for them would assert a history the site does not have. `/cli` and `/cli/http-server/**`, by contrast, are addresses production serves today, and the rename returns the pages to them. The rules the collections reorganization generated to send those addresses to `/provider` MUST therefore be removed rather than reversed, so no request is answered by a loop and no rule is shadowed by the page that now occupies its source.

#### Scenario: Reclaimed addresses are served rather than redirected

- **WHEN** `/cli`, `/cli/http-server`, `/cli/http-server/connection`, or `/cli/http-server/integration` is requested
- **THEN** the page is served without a redirect

#### Scenario: An address that was never published gets no rule

- **WHEN** the redirect rules are read
- **THEN** none of them has a `/provider/**` or `/sdk/cli` address as its source

#### Scenario: No rule survives that points into the renamed collection

- **WHEN** the redirect rules are replayed against the built site
- **THEN** no rule resolves into `/provider`, and no rule's source is a live page

#### Scenario: The rename costs no page its redirect budget

- **WHEN** the pre-move and pre-versioning URL inventories are replayed
- **THEN** every URL still resolves within the redirect budget its inventory allows

## MODIFIED Requirements

### Requirement: Internal links follow moved pages

Every internal link between documentation pages SHALL point at the target's new URL. Relying on a redirect from within the site's own content is not acceptable, so no internal link may target a pre-move URL. Inside a documentation line, a link to a page of the same versioned collection MUST resolve within that line, so a reader following links never leaves the line they are reading. A link to an unversioned page, or to a different versioned collection, is unconstrained by the line: the first resolves wherever that page lives, the second resolves at the target collection's current line, because no line of one collection is pinned to a line of another.

#### Scenario: No internal link targets a pre-move URL

- **WHEN** all internal links across the content are extracted
- **THEN** none of them targets a URL that only resolves through a redirect

#### Scenario: Links inside a line stay in that line

- **WHEN** the internal links of a page in documentation line `<line>` are extracted
- **THEN** every link to the same versioned collection resolves inside `<line>`

#### Scenario: A link out of the collection is left alone

- **WHEN** a page in an older line links to a Platform page, or to the CLI
- **THEN** the link resolves to that page as published, unprefixed by the reader's line

#### Scenario: No link survives the rename pointing at the old collection

- **WHEN** all internal links across the content and the site source are extracted
- **THEN** none of them targets `/provider` or `/sdk/cli`

#### Scenario: The link integrity check passes

- **WHEN** the link integrity check and the build-time broken-link check run against the reorganized site
- **THEN** both pass with no broken internal link, in every line
