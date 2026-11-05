## ADDED Requirements

### Requirement: A versioned collection publishes every line it has cut

A versioned collection SHALL publish the current line and every line a previous cut produced, with no upper bound. A line that has been published MUST NOT be removed, unpublished, or collapsed into another because a newer one was cut. A documentation line is the only record of how a released version behaved, and the readers who need it are the ones pinned to that version, so age is not a reason to withdraw it.

The cost is accepted rather than avoided: every cut adds that collection's whole page tree to the published set, to the search index, to the line's isolated agent corpus, and to the per-page Markdown twins. Nothing in the build is sized by the number of lines, so the cost grows in proportion and not in steps.

#### Scenario: The SDK publishes three lines

- **WHEN** the content tree is enumerated after this change ships with `@qvac/sdk` `0.20`
- **THEN** the SDK publishes `(v0.20)`, `v0.19`, and `v0.18`
- **AND** `v0.19` is what the collection's version-less paths served before the cut

#### Scenario: The CLI publishes three lines

- **WHEN** the content tree is enumerated after the CLI is cut to `0.14`
- **THEN** the CLI publishes `(v0.14)`, `v0.13`, and `v0.12`

#### Scenario: A cut pushes no line out

- **WHEN** a cut is made on a collection that already publishes its maximum-so-far number of lines
- **THEN** it proceeds, and the collection publishes one more line than before
- **AND** no existing line is retired, redirected away, or otherwise stops resolving

#### Scenario: A collection can publish one line

- **WHEN** a versioned collection has published only one release
- **THEN** it publishes one line, and everything except switching still works

#### Scenario: Adding a line requires no routing change

- **WHEN** a line folder is added and declared
- **THEN** it is published and offered by the switcher without any change to route definitions

#### Scenario: The switcher offers every published line

- **WHEN** a collection publishing more than two lines renders its switcher
- **THEN** every declared line is offered, in the order the manifest lists them

## REMOVED Requirements

### Requirement: At most two documentation lines per versioned collection

**Reason**: The cap blocked the routine cut it was meant to govern. Both versioned collections reached two lines, so publishing `@qvac/sdk` `0.20` and `@qvac/cli` `0.14` required deciding what becomes of the oldest line — the question the cap deferred by refusing to proceed. The decision is that nothing becomes of it: it stays published. Two was never a limit the system needed, only a floor chosen to prove that switching, fallback, canonical resolution, and corpus isolation work, and every one of those still works at three.

**Migration**: Replaced by `A versioned collection publishes every line it has cut`, which keeps the one-line and no-routing-change scenarios unchanged and drops only the refusal to publish a third. No content moves and no URL changes: the lines already published stay where they are, and the collections gain a line each.
