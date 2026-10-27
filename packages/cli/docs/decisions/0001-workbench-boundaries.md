# A new workbench shares the CLI and preserves execution boundaries

Status: partly superseded by [0002](0002-chat-first-branded-standalone.md) (chat first, header in chat, standalone app, `qvac serve`).

The new TUI joins active `@qvac/cli` rather than publishing a competing binary.
Existing SDK commands move under `qvac sdk` with explicit compatibility. Keep
`duck` for development/debugging until the new product proves equivalent coverage.
This workspace does not remove or modify duck.

Core owns replicated and local state. Client is the workbench's access to it.
QvacAssistant and its harness child own execution, policies, plugins and delegation.
The TUI must not instantiate another harness to gain missing features. Add
versioned host/API bridges. Host composition examples here are not client escape hatches.

One `qvac.config.*` convention retains SDK root fields and adds `harness`, `core`
and `tui` namespaces. SDK inference plugins, harness plugins and TUI extensions
are separate contracts. The LLM can propose configuration through a validated,
revision-checked change flow under the user's existing grants.

The product walkthrough is the initial design baseline: guided setup and a
serving dashboard with Overview, Device and Models. Add conversation as an
explicit later mode in the same visual language. Reveal workspace, model, team
and plugin capabilities as needed. Capability coverage does not mean displaying every command.
Test distribution, runtime composition and config compatibility at package boundaries.

Chat uses one compact context line and a contextual footer. The full serving
header, counters, logo and primary navigation do not persist into chat. Drafts
survive command search and secondary screens. Server single-letter shortcuts
never apply in the chat composer.
