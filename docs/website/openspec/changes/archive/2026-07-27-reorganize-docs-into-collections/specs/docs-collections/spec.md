## ADDED Requirements

### Requirement: Content is partitioned into collections

The documentation content SHALL be partitioned into collections. Each collection MUST be a single top-level folder under `content/docs`, and MUST own the URL namespace formed by its folder name. Every published page MUST belong to exactly one collection, so no page is reachable from two collections and no page sits outside a collection.

#### Scenario: Every published page belongs to a collection

- **WHEN** the content tree under `content/docs` is enumerated
- **THEN** every `.mdx` file resolves under exactly one top-level collection folder
- **AND** no `.mdx` file remains directly at the root of `content/docs`

#### Scenario: A collection owns its URL namespace

- **WHEN** a page belonging to collection `<collection>` is requested
- **THEN** its URL starts with `/<collection>/`

### Requirement: Collections introduced by this change

The site SHALL provide exactly four collections: `platform`, `sdk`, `provider`, and `resources`. The `app` and `research` collections anticipated by the target information architecture MUST NOT be created by this change.

#### Scenario: Only the four agreed collections exist

- **WHEN** the top-level folders under `content/docs` are listed
- **THEN** they are exactly `platform`, `sdk`, `provider`, and `resources`

#### Scenario: Deferred collections are absent

- **WHEN** the content tree is enumerated
- **THEN** no `app` or `research` collection folder exists

### Requirement: Platform collection composition

The `platform` collection SHALL hold the product-level material: what QVAC is, how it works, the software inventory, and the project background. It MUST be composed from these existing pages, with the current site index becoming the collection overview and the add-on pages nested under the inventory.

#### Scenario: Platform receives the site index as its overview

- **WHEN** the `platform` collection is enumerated
- **THEN** it contains an overview page whose content is the former `content/docs/index.mdx`

#### Scenario: Platform receives how-it-works and the about pages

- **WHEN** the `platform` collection is enumerated
- **THEN** it contains the former `about/how-it-works.mdx`
- **AND** it contains the former `about/vision.mdx` and `about/public-launch.mdx`

#### Scenario: Add-on pages are nested under the inventory

- **WHEN** the `platform` collection is enumerated
- **THEN** the nine former `addons/**` pages resolve under the collection's inventory section

### Requirement: SDK collection composition

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview.

#### Scenario: Introduction becomes the SDK overview

- **WHEN** the `sdk` collection is enumerated
- **THEN** it contains an overview page whose content is the former `introduction.mdx`

#### Scenario: SDK receives the remaining existing pages

- **WHEN** the `sdk` collection is enumerated
- **THEN** it contains the former `quickstart.mdx`, `system-requirements.mdx`, `installation.mdx`, and `troubleshooting.mdx`
- **AND** it contains the former `configuration/**`, `models/**`, `ai-capabilities/**`, `p2p-capabilities/**`, `runtime/**`, and `tutorials/**` pages
- **AND** it contains the former `reference/api/**` and `reference/release-notes/**` pages
- **AND** it contains the former `cli/index.mdx`

#### Scenario: Version-archive pages move without changing their versioning

- **WHEN** the former `reference/api/v*.mdx` and `reference/release-notes/v*.mdx` pages are enumerated after the move
- **THEN** each is present in the `sdk` collection
- **AND** its versioning behaviour is unchanged by this change

### Requirement: Provider collection composition

The `provider` collection SHALL hold the material about installing, configuring, and connecting the model provider server. It MUST be composed from the existing HTTP-server pages plus a single new overview page.

#### Scenario: Provider receives the HTTP-server pages

- **WHEN** the `provider` collection is enumerated
- **THEN** it contains the former `cli/http-server/index.mdx`, `cli/http-server/connection.mdx`, and `cli/http-server/integration.mdx`

#### Scenario: Provider sections without existing content are not authored

- **WHEN** the `provider` collection is enumerated
- **THEN** it contains no page for the anticipated Installation, Configuration, API reference, or Troubleshooting sections, because no existing page covers them

### Requirement: Resources collection composition

The `resources` collection SHALL be created as a navigable destination that will later index tutorials, how-tos, and sample projects hosted outside the docs site. Because no existing page covers that material, it MUST contain a single new index page and nothing else.

#### Scenario: Resources exists with only its index page

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains exactly one page, its index
- **AND** that page is reachable from the collection navigation

### Requirement: No content authored beyond two declared exceptions

This change SHALL NOT author documentation content. Exactly two new pages are permitted: the `provider` collection overview and the `resources` collection index, both of which exist solely so their collection is navigable. Every other page in every collection MUST be an existing page that was moved, and its body MUST be unchanged except for edits required to keep internal links valid.

#### Scenario: Only the two permitted new pages are added

- **WHEN** the set of pages after the change is compared with the set before
- **THEN** the only additions are the `provider` overview and the `resources` index

#### Scenario: Moved pages keep their content

- **WHEN** a moved page is compared with its pre-change version
- **THEN** the only differences are internal link targets that had to follow moved pages
