## MODIFIED Requirements

### Requirement: Collections introduced by this change

The site SHALL provide exactly four collections: `platform`, `sdk`, `cli`, and `resources`. The `app` and `research` collections anticipated by the target information architecture MUST NOT be created by this change.

#### Scenario: Only the four agreed collections exist

- **WHEN** the top-level folders under `content/docs` are listed
- **THEN** they are exactly `platform`, `sdk`, `cli`, and `resources`

#### Scenario: Deferred collections are absent

- **WHEN** the content tree is enumerated
- **THEN** no `app` or `research` collection folder exists

#### Scenario: No collection is named after a feature of the package it tracks

- **WHEN** a versioned collection's name is compared with the package its lines follow
- **THEN** the name identifies that package rather than one of the things it does

### Requirement: SDK collection composition inside its lines

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection, and the API reference and release notes MUST keep only their current series, since the patch-series archives are superseded by the line model and belong to the Software Inventory. The collection MUST NOT document the CLI, which is released on its own package and documented in its own collection.

#### Scenario: Introduction becomes the SDK overview

- **WHEN** the `sdk` collection is enumerated
- **THEN** it contains an overview page whose content is the former `introduction.mdx`

#### Scenario: SDK receives the remaining existing pages

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains the former `system-requirements.mdx` and `troubleshooting.mdx`, plus `js-ts-sdk.mdx` and `python-sdk.mdx`, the per-client pages that absorbed the former `quickstart.mdx` and `installation.mdx`
- **AND** it contains the former `configuration/**`, `models/**`, `ai-capabilities/**`, `p2p-capabilities/**`, `runtime/**`, and `tutorials/**` pages
- **AND** it contains the former `reference/api/index.mdx` and `reference/release-notes/index.mdx`

#### Scenario: The SDK no longer documents the CLI

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains no CLI page
- **AND** the collection's declared navigation offers no CLI entry

#### Scenario: Every SDK page sits inside a line

- **WHEN** the `sdk` collection folder is enumerated
- **THEN** every page under it sits inside a documentation-line folder

#### Scenario: The patch-series archives leave the published set

- **WHEN** the former `reference/api/v*.mdx` and `reference/release-notes/v*.mdx` pages are enumerated
- **THEN** none of them is published
- **AND** each is retained unpublished, with its former URL redirecting to the current series

## ADDED Requirements

### Requirement: CLI collection composition

The `cli` collection SHALL hold the material about installing and using `@qvac/cli`, the whole tool rather than one of its features. It MUST be composed from the CLI page the SDK collection gives up, which becomes the collection overview, and the HTTP-server pages, which document the model provider as one of the tool's functions. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection.

#### Scenario: The CLI page becomes the collection overview

- **WHEN** a documentation line of the `cli` collection is enumerated
- **THEN** its index is the former `sdk/<line>/cli.mdx`, covering installation, the command reference, and each function of the tool

#### Scenario: The CLI collection holds the HTTP-server pages

- **WHEN** a documentation line of the `cli` collection is enumerated
- **THEN** it contains the HTTP-server index, connection, and integration pages
- **AND** they are reached from the overview rather than from a second overview of their own

#### Scenario: Every CLI page sits inside a line

- **WHEN** the `cli` collection folder is enumerated
- **THEN** every page under it sits inside a documentation-line folder

#### Scenario: CLI sections without existing content are not authored

- **WHEN** the `cli` collection is enumerated
- **THEN** it contains no page for the anticipated Configuration, API reference, or Troubleshooting sections, because no existing page covers them

## REMOVED Requirements

### Requirement: Provider collection composition

**Reason**: The collection was named after the model provider, which is `qvac serve` — one feature of `@qvac/cli`, the package whose releases the collection's lines already followed. Naming a collection after a feature split one tool's documentation across two collections and versioned half of it against another package.

**Migration**: `CLI collection composition` replaces it. The HTTP-server pages it required are unchanged and still required, now alongside the CLI overview rather than under an overview of the provider; the Provider overview page is retired and its cards move onto that overview.
