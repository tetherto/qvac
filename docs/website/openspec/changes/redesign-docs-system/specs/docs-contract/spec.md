## ADDED Requirements

### Requirement: Every documented software declares a kind

Every documented software SHALL declare one kind, and the kind SHALL determine which pages its documentation must contain.

- A `product` (today the SDK and the CLI) MUST provide an overview, installation, requirements and supported platforms, a quickstart, usage pages, configuration, an API reference, troubleshooting, and a link to its release notes.
- A `platform` package MUST provide an overview, installation, supported platforms or backends, usage pages, and an API reference.

#### Scenario: A missing required page fails the pull request

- **WHEN** a pull request leaves a `product` without an installation page
- **THEN** the contract check fails and names the software and the missing page

### Requirement: Every page declares a type and satisfies it

Every hand-written page SHALL declare a page type, and each page type SHALL define:

- its required sections;
- its required frontmatter fields;
- the data components that must render its facts.

A page MUST contain every required section of its type. A fact its type assigns to a data component MUST NOT be written as prose. The elements of each page type are defined in the contract's page-type files.

#### Scenario: A missing section fails the pull request

- **WHEN** a capability page lacks a section its page type requires
- **THEN** the contract check fails and names the page and the section

#### Scenario: A fact written by hand fails the pull request

- **WHEN** a page lists its input fields as prose where its page type requires the schema table
- **THEN** the contract check fails and names the page

### Requirement: The contract is checked on pull requests, never at build

The contract SHALL be checked on the documentation a pull request authors. The site build MUST NOT check the contract, so a new contract rule never fails the build of a line pinned before it. This guarantee covers the contract's rules only. A change to a data component's interface MAY break an older line's build, and no backward compatibility is guaranteed for components.

#### Scenario: An older line builds under a newer contract

- **WHEN** the contract gains a required section after a line was pinned
- **THEN** that line still builds, and only pull requests authoring documentation are held to the new section

### Requirement: The contract is applied by tooling, not memorized

The contract SHALL be distributed as machine-readable kind and page-type definitions, page scaffolds, and agent skills. A developer documenting a change MUST be able to produce conforming pages through the documentation skill without reading the contract. The developer judges only whether the output is complete, correct, and sufficient.

#### Scenario: A new page starts from its scaffold

- **WHEN** the documentation skill creates a page of a given type
- **THEN** the page starts with every required section and data component of that type
