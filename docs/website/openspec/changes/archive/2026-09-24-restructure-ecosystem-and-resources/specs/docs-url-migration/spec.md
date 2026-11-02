## ADDED Requirements

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
