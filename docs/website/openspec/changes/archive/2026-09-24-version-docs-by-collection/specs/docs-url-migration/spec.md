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

- **WHEN** a page in an older line links to a Platform page, or to the Provider
- **THEN** the link resolves to that page as published, unprefixed by the reader's line

#### Scenario: The link integrity check passes

- **WHEN** the link integrity check and the build-time broken-link check run against the reorganized site
- **THEN** both pass with no broken internal link, in every line

## ADDED Requirements

### Requirement: Pre-existing URLs keep resolving, or their loss is recorded

Because a collection name becomes part of every path, the reorganization changes every page URL. A URL that resolved before the change SHALL keep resolving afterwards wherever a redirect rule can express the mapping. Continuity SHALL be pursued through `public/_redirects` alone: no route, module, or function may be added to the site to make an old URL resolve. Where no rule can express a mapping, the URL MAY fall through to the 404, and the loss MUST be recorded rather than engineered around. Introducing documentation lines keeps continuity where it costs nothing: the version-less paths keep resolving and keep serving the current line, needing no rule at all, and the URLs leaving the published set — the retired patch-series archives, and any page a cut drops — are each a rule away.

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

## REMOVED Requirements

### Requirement: Pre-existing URLs keep resolving

**Reason**: The requirement admitted no loss: one of its scenarios asserted that no pre-existing URL reaches the 404 catch-all. That absolute holds today and the build gate proves it, but it cannot be promised across a cut into documentation lines, where a line may drop a page the previous line published.

**Migration**: Replaced by "Pre-existing URLs keep resolving, or their loss is recorded", which keeps the redirect-only continuity rule and the prohibition on adding code to revive a URL, and replaces the absolute with an obligation: a URL no rule can cover is listed as knowingly dropped rather than treated as a defect to fix in code.
