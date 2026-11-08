## ADDED Requirements

### Requirement: Every documented software declares a kind

Every documented software SHALL declare one kind, and the kind SHALL determine which pages its documentation must contain.

- A `product` (today the SDK and the CLI) curates its own pages. The contract requires none of them.
- A `platform` package MUST provide an overview, installation, supported platforms or backends, usage pages, and its generated API reference.

#### Scenario: A missing required page fails the pull request

- **WHEN** a pull request leaves a `platform` package without an installation page
- **THEN** the contract check fails and names the package and the missing page

#### Scenario: A product's pages are its own

- **WHEN** a pull request removes a hand-written page from a `product`, and no public symbol is left unbound
- **THEN** the contract check passes

### Requirement: The contract is checked on pull requests, never at build

The contract SHALL be checked on the documentation a pull request authors. The site build MUST NOT check the contract, so a new contract rule never fails the build of a line pinned before it. This guarantee covers the contract's rules only. A change to a data component's interface MAY break an older line's build, and no backward compatibility is guaranteed for components.

#### Scenario: An older line builds under a newer contract

- **WHEN** the contract gains a required page for `platform` packages after a package's line was pinned
- **THEN** that line still builds, and only pull requests authoring documentation are held to the new page

### Requirement: The contract is applied by tooling, not memorized

The contract SHALL be distributed as machine-readable kind definitions, a scaffold for a `platform` package's pages, and agent skills. A developer documenting a change MUST be able to produce conforming pages through the documentation skill without reading the contract. The developer judges only whether the output is complete, correct, and sufficient.

#### Scenario: A new platform package starts from its scaffold

- **WHEN** the scaffold skill creates the documentation of a `platform` package
- **THEN** it contains every page the `platform` kind requires
