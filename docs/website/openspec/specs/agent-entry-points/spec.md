# agent-entry-points Specification

## Purpose
How a reader is handed the means to point an AI agent at this documentation. The navbar menu gathering them, why the MCP address is copied rather than opened, why only the site-wide artifacts are named when a cascade of them exists, the naming of the page that explains how an agent picks a release, and the two gates that hold the menu — one on its declared shape, one on its presence in the built site.

Distinct from `versioned-agent-artifacts`, which governs what is published for agents and how it is scoped, and from `versioned-search`, which governs the assistant that answers here. This capability is the handoff: the moment the documentation leaves for somewhere else.
## Requirements
### Requirement: The navbar offers a menu leading to the agent-facing surface

The site SHALL offer, from the top navbar on every documentation page, a menu gathering the means by which a reader points an AI agent at this documentation. The menu MUST be reachable without knowing any URL, and MUST sit beside the AI assistant, which answers questions here where the menu hands the documentation elsewhere.

The menu SHALL hold, in this order:

- the address of the MCP server,
- the site's resolver index,
- the site's full corpus,
- the page explaining how an agent picks the documentation matching a release.

#### Scenario: The menu is on every page

- **WHEN** any documentation page is rendered
- **THEN** its navbar carries the menu, with the same entries in the same order

#### Scenario: The menu gathers the four entry points

- **WHEN** the menu is opened
- **THEN** it offers the MCP server, the resolver index, the full corpus, and the page on using the documentation with agents

### Requirement: The MCP address is given as something to paste, not to open

The entry for the MCP server SHALL place the server's address on the reader's clipboard and MUST NOT navigate. The address is an endpoint rather than a page: opened in a browser it yields a stream or an error, and what a reader needs is the text itself, to paste into an agent's configuration.

The entry MUST confirm that it copied, so the reader is not left guessing whether anything happened.

#### Scenario: The address is copied

- **WHEN** the reader activates the MCP entry
- **THEN** the server's address is on the clipboard

#### Scenario: The entry does not navigate

- **WHEN** the built menu is inspected
- **THEN** the MCP entry carries no link

#### Scenario: The copy is acknowledged

- **WHEN** the address has been copied
- **THEN** the entry says so, for long enough to be seen

### Requirement: The menu offers the site-wide artifacts, not one per line

The menu SHALL name the resolver index and the full corpus published at the site root, and MUST NOT name a collection's or a documentation line's own. The root index resolves downward to both, so one entry point is offered rather than a list that lengthens with every line cut.

The menu MUST NOT vary with the reader's position. A reader inside a past documentation line is offered the same entries as any other, because choosing a line for an agent is what the protocol page and the resolver index exist to do properly.

#### Scenario: The root artifacts are what is offered

- **WHEN** the menu is opened anywhere on the site
- **THEN** its artifact entries address the site root's resolver index and full corpus

#### Scenario: The menu does not follow the reader's line

- **WHEN** the menu is opened on a page of a past documentation line
- **THEN** its entries are the same as on any other page

### Requirement: The protocol page is named for the documentation, not for the activity

The page the menu's last entry leads to SHALL be named for what it is — documentation for AI agents — rather than for building with AI. The site documents building AI features elsewhere, in the SDK's AI capabilities, and a page named for that activity competes with those pages while describing something else: how an agent chooses the documentation matching the release a project has installed.

#### Scenario: The page is named for what it holds

- **WHEN** the page is published
- **THEN** its title, its sidebar label, and its URL all name it as documentation for AI agents

#### Scenario: Every artifact citing it follows

- **WHEN** an agent artifact cites the page
- **THEN** it cites the page's current address, and no artifact cites the former one

### Requirement: The menu is gated in the two places it can be seen

The menu's entries do not reach the built site: they are rendered into a popover that mounts when a reader opens it, so a built page carries the menu's trigger and nothing more. The menu SHALL therefore be gated in two places, each holding what it can see, and MUST NOT be left ungated on the grounds that neither can hold all of it.

Its entries SHALL be declared as data in one module, and their shape MUST be asserted against that declaration: the entries present, their order, the MCP entry carrying no URL, and the page entry carrying the same constant every agent artifact cites.

Its presence SHALL be asserted against the built pages, alongside the navbar's other assertions and in the same place, so one gate covers the navbar rather than two disagreeing about what it holds. That check MUST verify that every rendering of the navbar on every page it samples offers the menu, and that each trigger is a control that opens rather than a link that navigates.

Whether each entry's URL resolves is already held by the check that resolves every URL the site publishes, since the menu names only addresses that check already covers.

#### Scenario: A menu that lost an entry fails

- **WHEN** the declared entries differ from the entries the menu requires, in content or in order
- **THEN** the assertion on the declaration fails

#### Scenario: An MCP entry given a URL fails

- **WHEN** the MCP entry is declared with a URL
- **THEN** the assertion fails, because the framework would render it as a link and a reader following it would get the stream the copy exists to avoid

#### Scenario: A page entry drifting from the artifacts fails

- **WHEN** the page entry names an address other than the constant the agent artifacts cite
- **THEN** the assertion fails

#### Scenario: A build without the menu fails

- **WHEN** a built page offers no trigger for the menu
- **THEN** the check fails and names the page

#### Scenario: A trigger turned into a link fails

- **WHEN** any rendering of the trigger on a built page is a link rather than a control
- **THEN** the check fails and says what it became

### Requirement: The page answers for everything the site offers an agent

The page the menu leads to SHALL cover every resource this site addresses to an AI agent, not one of them. A reader arriving from the menu MUST be able to discover all of them and use any one without leaving the page.

It SHALL open by naming them, then take each in turn. For each, it MUST say what the resource is for and how to use it, and MUST say how the versioned collections change its use wherever that is not evident from the second. It MUST NOT carry a section that exists only for symmetry.

#### Scenario: The overview names every resource

- **WHEN** the page is read
- **THEN** it opens by naming each resource the site offers an agent, before explaining any of them

#### Scenario: Every named resource is explained

- **WHEN** a resource is named in the overview
- **THEN** the page holds a section saying what it is for and how to use it

#### Scenario: A resource with nothing further to say gets no filler

- **WHEN** a resource's use is not changed by the versioned collections
- **THEN** its section says so by omission rather than by an empty part

### Requirement: The page addresses its reader directly, whoever that is

The page SHALL be written to be read by a person and by an agent at once, in the second person and in plain instructions. It MUST NOT be written for agents with an aside redirecting humans elsewhere, because that leaves the human half a pointer and the agent half a register no person wants to read.

Where the two readers genuinely act differently, the page MUST say which reader each instruction is for, rather than splitting the page.

#### Scenario: Instructions are given as instructions

- **WHEN** the page tells a reader to do something
- **THEN** it says so directly, in the second person

#### Scenario: A divergence is marked, not separated

- **WHEN** a person and an agent would take different actions to the same end
- **THEN** the page names both in place, and does not send either reader to a different section

### Requirement: The page carries only what is needed to use something

Every unit of information on the page SHALL be one a reader needs in order to use one of the resources. Anything explaining how the site is built, or why a mechanism is the way it is, MUST be cut.

A fact that changes what a reader receives from a request counts as usage, not background. A corpus withholding part of its line, or declaring its own scope, is such a fact.

#### Scenario: Construction is not explained

- **WHEN** the page describes a resource
- **THEN** it says how to use it and not how it is produced

#### Scenario: What a fetch returns is stated

- **WHEN** a resource returns less than a reader would assume
- **THEN** the page says so, and says where to get the remainder

### Requirement: The versioning caution is given once, where it applies to all

The page SHALL carry one section on what a reader must be careful about because several collections are versioned, rather than repeating the caution in each resource's section. That section MUST cover what a documentation line is, how to resolve the one matching a release, what to do when no line matches, and the rule against combining two lines of one collection.

A resource's own section MUST point to it only where the interaction is not obvious.

#### Scenario: The caution is in one place

- **WHEN** the page is read
- **THEN** the versioning caution appears once, as its own section, and is not restated per resource

#### Scenario: Resolving a line is actionable

- **WHEN** a reader needs the documentation matching a release
- **THEN** the section tells them how to resolve it, and what to do when no published line matches

