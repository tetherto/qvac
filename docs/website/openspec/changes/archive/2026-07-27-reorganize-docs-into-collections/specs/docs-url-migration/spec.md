## ADDED Requirements

### Requirement: Pre-existing URLs keep resolving

Because a collection name becomes part of every path, the reorganization changes every page URL. Every URL that resolved before the change SHALL keep resolving afterwards, by redirecting to the page's new location. No pre-existing URL may fall through to the catch-all 404.

#### Scenario: A moved page's old URL redirects to its new location

- **WHEN** a URL that resolved before the change is requested
- **THEN** the site redirects to the same page's new collection-scoped URL

#### Scenario: No pre-existing URL reaches the catch-all

- **WHEN** the set of pre-existing URLs is replayed against the built site
- **THEN** none of them resolves to the 404 catch-all

### Requirement: The site root resolves to the Platform overview

The former site index becomes the Platform collection overview, so the root path SHALL redirect there rather than 404 or serve a duplicate of that content.

#### Scenario: Root redirects to the Platform overview

- **WHEN** the site root is requested
- **THEN** the site redirects to the Platform collection overview

### Requirement: Internal links follow moved pages

Every internal link between documentation pages SHALL point at the target's new URL. Relying on a redirect from within the site's own content is not acceptable, so no internal link may target a pre-move URL.

#### Scenario: No internal link targets a pre-move URL

- **WHEN** all internal links across the content are extracted
- **THEN** none of them targets a URL that only resolves through a redirect

#### Scenario: The link integrity check passes

- **WHEN** the link integrity check and the build-time broken-link check run against the reorganized site
- **THEN** both pass with no broken internal link

### Requirement: Derived surfaces reflect the new paths

The surfaces generated from the page tree SHALL be consistent with the new URLs, so that machine consumers are not left pointing at pre-move paths.

#### Scenario: Generated surfaces carry the new URLs

- **WHEN** the site is built
- **THEN** the sitemap, the search index, `llms.txt`, `llms-full.txt`, the per-page Markdown files with their manifest, and the OG images all reference collection-scoped URLs

#### Scenario: No generated surface carries a pre-move URL

- **WHEN** the generated surfaces are inspected after a build
- **THEN** none of them lists a pre-move URL as a canonical page location
