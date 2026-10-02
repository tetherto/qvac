## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: The site root resolves to the Ecosystem overview

The former site index becomes the Ecosystem collection overview, so the root path SHALL redirect there rather than 404 or serve a duplicate of that content.

#### Scenario: Root redirects to the Ecosystem overview

- **WHEN** the site root is requested
- **THEN** the site redirects to the Ecosystem collection overview

## REMOVED Requirements

### Requirement: The site root resolves to the Platform overview

**Reason**: The collection the root lands on is renamed, and the requirement names it in its own title and in its only scenario. A scenario cannot be renamed inside a MODIFIED block, because OpenSpec refuses to drop a scenario the baseline carries.

**Migration**: Replaced by "The site root resolves to the Ecosystem overview", identical in substance: the former site index is that collection's overview, and the root redirects there rather than serving a duplicate.
