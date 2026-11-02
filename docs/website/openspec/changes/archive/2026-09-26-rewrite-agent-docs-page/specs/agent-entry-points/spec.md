## ADDED Requirements

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
