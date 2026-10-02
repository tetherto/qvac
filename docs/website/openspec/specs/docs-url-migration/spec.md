## Purpose

URL continuity across the move into collections. Every pre-existing URL still resolves or has its loss recorded, the root lands on the Ecosystem overview, internal links point at the new locations rather than relying on redirects, and the surfaces generated from the page tree carry the new paths.
## Requirements
### Requirement: Internal links follow moved pages

Every internal link between documentation pages SHALL point at the target's new URL. Relying on a redirect from within the site's own content is not acceptable, so no internal link may target a pre-move URL. Inside a documentation line, a link to a page of the same versioned collection MUST resolve within that line, so a reader following links never leaves the line they are reading. A link to an unversioned page, or to a different versioned collection, is unconstrained by the line: the first resolves wherever that page lives, the second resolves at the target collection's current line, because no line of one collection is pinned to a line of another.

#### Scenario: No internal link targets a pre-move URL

- **WHEN** all internal links across the content are extracted
- **THEN** none of them targets a URL that only resolves through a redirect

#### Scenario: Links inside a line stay in that line

- **WHEN** the internal links of a page in documentation line `<line>` are extracted
- **THEN** every link to the same versioned collection resolves inside `<line>`

#### Scenario: A link out of the collection is left alone

- **WHEN** a page in an older line links to an Ecosystem page, or to the CLI
- **THEN** the link resolves to that page as published, unprefixed by the reader's line

#### Scenario: No link survives the rename pointing at the old collection

- **WHEN** all internal links across the content and the site source are extracted
- **THEN** none of them targets `/provider`, `/sdk/cli`, or `/platform`

#### Scenario: The link integrity check passes

- **WHEN** the link integrity check and the build-time broken-link check run against the reorganized site
- **THEN** both pass with no broken internal link, in every line

### Requirement: Derived surfaces reflect the new paths

The surfaces generated from the page tree SHALL be consistent with the new URLs, so that machine consumers are not left pointing at pre-move paths.

#### Scenario: Generated surfaces carry the new URLs

- **WHEN** the site is built
- **THEN** the sitemap, the search index, `llms.txt`, `llms-full.txt`, the per-page Markdown files with their manifest, and the OG images all reference collection-scoped URLs

#### Scenario: No generated surface carries a pre-move URL

- **WHEN** the generated surfaces are inspected after a build
- **THEN** none of them lists a pre-move URL as a canonical page location

### Requirement: Pre-existing URLs keep resolving, or their loss is recorded

Because a collection name becomes part of every path, the reorganization changes every page URL. A URL that resolved before the change SHALL keep resolving afterwards wherever a redirect rule can express the mapping. Continuity SHALL be pursued through `public/_redirects` alone: no route, module, or function may be added to the site to make an old URL resolve. Where no rule can express a mapping, the URL MAY fall through to the 404, and the loss MUST be recorded rather than engineered around. Introducing documentation lines keeps continuity where it costs nothing: the version-less paths keep resolving and keep serving the current line, needing no rule at all, and the URLs leaving the published set — the retired patch-series archives, the retired project pages, and any page a cut drops — are each a rule away. A URL whose page is retired SHALL answer with the nearest published page rather than a 404, because a rule can always express that.

#### Scenario: A moved page's old URL redirects to its new location

- **WHEN** a URL that resolved before the change is requested
- **THEN** the site redirects to the same page's new collection-scoped URL

#### Scenario: A covered URL resolves and an uncovered one is recorded

- **WHEN** the set of pre-existing URLs is replayed against the built site
- **THEN** every URL a rule covers resolves
- **AND** every URL no rule covers is listed as knowingly dropped, rather than treated as a defect to fix in code

#### Scenario: No code is added to keep a URL alive

- **WHEN** a mapping cannot be expressed as a redirect rule
- **THEN** the URL is allowed to 404
- **AND** no route, module, or function is added to resolve it

#### Scenario: Versioning retires no URL

- **WHEN** the set of URLs published before versioning is replayed against the built site
- **THEN** every URL of a versioned collection still resolves at its version-less path, without a redirect
- **AND** it serves that page from the current line

#### Scenario: Retired archive URLs redirect

- **WHEN** a URL of a retired patch-series archive is requested
- **THEN** the site redirects to the current series of that section

#### Scenario: A retired page's URL reaches its collection overview

- **WHEN** the production URL of the retired vision or launch page is requested
- **THEN** the site redirects to the Ecosystem collection overview

#### Scenario: A page that changes collection keeps its production URL resolving

- **WHEN** the production URL of the page on how it works is requested
- **THEN** the site redirects to that page in the SDK's current line

### Requirement: Internal links are authored version-less and resolved per line

Authors SHALL keep writing internal links as version-less absolute paths — `/sdk/configuration/` — in every line, including older ones. The build SHALL resolve each same-collection link into the line of the page that carries it, prefixing the line segment when that page belongs to an older line and leaving the link untouched when it belongs to the current line. Resolution MUST happen before the page is rendered and before its Markdown twin is emitted, so HTML and Markdown carry the same resolved URL. Link source text MUST NOT be rewritten when a line is cut: two lines of the same page differ only where their content differs.

#### Scenario: An older line's link is prefixed at build

- **WHEN** a page in `v0.18` links to `/sdk/configuration/`
- **THEN** the built page links to `/sdk/v0.18/configuration/`

#### Scenario: The current line's link is untouched

- **WHEN** a page in the current line links to `/sdk/configuration/`
- **THEN** the built page links to `/sdk/configuration/`

#### Scenario: The Markdown twin carries the resolved link

- **WHEN** the Markdown of a page in `v0.18` is fetched
- **THEN** its links are the same resolved URLs the HTML carries

#### Scenario: A cut rewrites no link

- **WHEN** a line is cut and the two folders are compared
- **THEN** no difference between them is a link rewrite

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

### Requirement: The site root resolves to the Ecosystem overview

The former site index becomes the Ecosystem collection overview, so the root path SHALL redirect there rather than 404 or serve a duplicate of that content.

#### Scenario: Root redirects to the Ecosystem overview

- **WHEN** the site root is requested
- **THEN** the site redirects to the Ecosystem collection overview

### Requirement: An address the site never served is retired, not redirected

A redirect SHALL be added only for an address the site has served. An address that exists solely on an unreleased branch — a page renamed before it ever shipped, a path introduced and withdrawn within the same unreleased work — MUST be retired outright, with no rule left behind, because a rule for it asserts a history the site does not have and costs a lookup on every request that will never come. Whether an address was served SHALL be decided against what production serves and the recorded URL fixtures, not against what the branch happens to have built.

#### Scenario: A page renamed before it shipped leaves no rule

- **WHEN** a page authored on the current branch is renamed before the branch is released
- **THEN** its former address gets no redirect rule
- **AND** the address resolves to the 404

#### Scenario: A page renamed after it shipped keeps its address resolving

- **WHEN** a page that production serves is renamed
- **THEN** its former address redirects to the new one

#### Scenario: The question is settled against production and the fixtures

- **WHEN** it is unclear whether an address was ever served
- **THEN** it is checked against what production serves and against the recorded URL fixtures
- **AND** an address absent from both is treated as never served

### Requirement: A page that changes collection redirects in one hop

When a page moves from one collection to another, every address the site serves for it SHALL reach its new address in a single redirect. A rule that already points at the page's old collection MUST be retargeted at the new one rather than left to chain through it, so that a reader following an old link takes one hop and not two. This SHALL hold for the page's Markdown twin as well as for the page itself.

#### Scenario: The current address redirects straight to the new one

- **WHEN** the address the page is served at today is requested after it changes collection
- **THEN** the site redirects once, to the page's address in its new collection

#### Scenario: An older rule is retargeted rather than chained

- **WHEN** a rule already redirects a pre-collections address to the page's old collection
- **THEN** that rule is retargeted at the new collection
- **AND** the pre-collections address reaches the page in one hop

#### Scenario: The Markdown twin moves with the page

- **WHEN** the Markdown address of a page that changed collection is requested
- **THEN** it redirects once, to the Markdown address in the new collection

#### Scenario: The line-scoped addresses of a moved page get no rule

- **WHEN** a page that lived in every documentation line leaves them all
- **THEN** its version-less address redirects to the new collection
- **AND** its line-scoped addresses get no rule, because the site never served them

