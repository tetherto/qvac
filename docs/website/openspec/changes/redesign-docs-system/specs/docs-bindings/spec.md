## ADDED Requirements

### Requirement: Hand-written pages bind the API symbols they describe

A hand-written page that documents API behaviour SHALL declare the symbols it describes by stable symbol identifiers, not by source file paths. Generated pages MUST NOT declare bindings, because the freshness check already keeps them current.

#### Scenario: A binding survives a file move

- **WHEN** the source file defining a bound symbol is moved without changing the symbol's surface
- **THEN** no binding check fails

### Requirement: A surface change requires a recorded page review

Each package SHALL keep a lock that records, per binding, the hash of the bound symbol's projected public surface at the page's last review. The projected surface is the symbol's signature, expanded types, and field descriptions, normalized. A pull request that changes a bound surface without updating the lock MUST fail and name each affected page. Updating the lock records the review in the pull request's diff.

#### Scenario: A changed surface fails without review

- **WHEN** a pull request adds a field to a bound SDK request and leaves the lock unchanged
- **THEN** the binding check fails and names every page bound to that request

#### Scenario: An internal refactor passes

- **WHEN** a pull request changes a bound symbol's implementation but not its projected surface
- **THEN** the binding check passes

#### Scenario: A recorded review passes

- **WHEN** the pull request updates the affected pages and the lock
- **THEN** the binding check passes, and the lock change appears in its diff

### Requirement: Binding rigor follows the software's kind

A `product` SHALL bind per symbol, and a coverage check MUST fail when a public symbol is bound by no page. A `platform` package SHALL bind its whole public surface as one binding, with no coverage check.

#### Scenario: An unbound product symbol fails coverage

- **WHEN** an SDK function is exported and no page binds it
- **THEN** the coverage check fails and names the function

#### Scenario: A package surface change flags its usage pages

- **WHEN** a package's public declarations change
- **THEN** every page bound to that package's surface is named by the binding check
