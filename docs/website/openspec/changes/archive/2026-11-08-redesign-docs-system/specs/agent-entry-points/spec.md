## ADDED Requirements

### Requirement: The protocol page declares the site the reference source

The agent protocol page SHALL tell an agent that the site holds everything needed to use QVAC at the version in use: the API, the prose, and the examples. It SHALL tell the agent to prefer the site over package sources for understanding the API. It SHALL tell the agent to stay on the site's channels once it has found them. A person pointing an agent at the site MUST be able to rely on that alone.

#### Scenario: An agent learns where to stay

- **WHEN** an agent reads the protocol page
- **THEN** it is told that the site is the reference source for the API, the prose, and the examples of its version
- **AND** it is told to prefer the site's channels over package sources

#### Scenario: Every channel leads to the protocol

- **WHEN** an agent enters by the `llms.txt` corpus, a Markdown twin, or the MCP server
- **THEN** that channel points it to the protocol page
