## MODIFIED Requirements

### Requirement: Resources holds the unversioned supporting material

The `resources` collection SHALL NOT be versioned, and MUST therefore be the home of the material that supports the products without documenting a release of one. Its pages sit directly under the collection rather than inside a documentation line, and MUST NOT be copied into one when a line is cut. It MUST hold the tutorials and the help material the SDK gives up, and the page telling an AI agent how to pick the documentation matching a release, which is named for the documentation it describes rather than for the activity of building with AI — an activity the SDK's own pages document.

#### Scenario: Resources holds unversioned supporting material

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains its index page alongside the supporting pages, and no documentation-line folder

#### Scenario: Solutions are published unversioned

- **WHEN** a Solutions page is published
- **THEN** it resolves under `/resources/solutions/` with no version segment
- **AND** cutting a line in any collection leaves it untouched

#### Scenario: Resources receives the tutorials and the help material

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains the former `sdk/<line>/tutorials/**` pages and the former `sdk/<line>/troubleshooting.mdx`
- **AND** each sits directly under the collection, in one copy

#### Scenario: The Corpus protocol page is renamed for what it lets a reader do

- **WHEN** the `resources` collection is enumerated
- **THEN** the former Corpus protocol page is published as Docs for AI agents, at `/resources/docs-for-ai-agents`
- **AND** its sidebar label, its page title, and its URL all carry that name
- **AND** the name describes the documentation rather than the activity of building with AI, which the SDK's own pages document

#### Scenario: The overview describes the scope the collection has

- **WHEN** the Resources overview is read
- **THEN** it describes the material the collection now holds
- **AND** it offers the Recipes section of the main website in place of the former undifferentiated link to it
