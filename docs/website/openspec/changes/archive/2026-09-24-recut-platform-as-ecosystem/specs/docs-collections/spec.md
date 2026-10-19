## MODIFIED Requirements

### Requirement: Collections introduced by this change

The site SHALL provide exactly four collections: `ecosystem`, `sdk`, `cli`, and `resources`. The `app` and `research` collections anticipated by the target information architecture MUST NOT be created by this change. A collection MUST be named after what it holds, so a collection is renamed when what it holds changes.

#### Scenario: Only the four agreed collections exist

- **WHEN** the top-level folders under `content/docs` are listed
- **THEN** they are exactly `ecosystem`, `sdk`, `cli`, and `resources`

#### Scenario: Deferred collections are absent

- **WHEN** the content tree is enumerated
- **THEN** no `app` or `research` collection folder exists

#### Scenario: No collection is named after a feature of the package it tracks

- **WHEN** a versioned collection's name is compared with the package its lines follow
- **THEN** the name identifies that package rather than one of the things it does

### Requirement: SDK collection composition inside its lines

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection, and the API reference and release notes MUST keep only their current series, since the patch-series archives are superseded by the line model and belong to the Software Inventory. The collection MUST NOT document the CLI, which is released on its own package and documented in its own collection. It MUST hold the page describing what happens under the hood when an application uses the SDK, in every line, because that page documents the software this collection is about.

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

#### Scenario: The SDK holds the page on how it works

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains the former `about/how-it-works.mdx`
- **AND** the line's overview reaches it without leaving the collection

#### Scenario: Every SDK page sits inside a line

- **WHEN** the `sdk` collection folder is enumerated
- **THEN** every page under it sits inside a documentation-line folder

#### Scenario: The patch-series archives leave the published set

- **WHEN** the former `reference/api/v*.mdx` and `reference/release-notes/v*.mdx` pages are enumerated
- **THEN** none of them is published
- **AND** each is retained unpublished, with its former URL redirecting to the current series

## ADDED Requirements

### Requirement: Ecosystem collection composition

The `ecosystem` collection SHALL hold what QVAC publishes: the Software Inventory of the released packages and the add-on catalogue, entered from an overview. It MUST NOT hold material that documents no distributable, so the project's vision and its launch announcement leave the published set rather than moving with it, and the page on how the SDK works moves to the SDK.

#### Scenario: Ecosystem receives the site index as its overview

- **WHEN** the `ecosystem` collection is enumerated
- **THEN** it contains an overview page whose content is the former `content/docs/index.mdx`

#### Scenario: Ecosystem holds the inventory and the add-ons, and nothing else

- **WHEN** the `ecosystem` collection is enumerated
- **THEN** it contains the Software Inventory and the add-on pages nested under it
- **AND** it contains no `about/` section

#### Scenario: The vision and the launch announcement are retired

- **WHEN** the former `about/vision.mdx` and `about/public-launch.mdx` are enumerated
- **THEN** neither is published
- **AND** each is retained unpublished, with its former URL redirecting to the collection overview

## REMOVED Requirements

### Requirement: Platform collection composition

**Reason**: The requirement defined the collection as the home of "the product-level material: what QVAC is, how it works, the software inventory, and the project background". Three of those four leave here — `how-it-works` to the SDK, the vision and the launch announcement out of the published set — so what the requirement describes no longer matches what the collection holds, and neither does its name.

**Migration**: Replaced by "Ecosystem collection composition", which keeps the inventory, the add-ons nested under it, and the site index as the overview, and states the rule that produced the rename: the collection holds what QVAC publishes, and nothing that documents no distributable.
