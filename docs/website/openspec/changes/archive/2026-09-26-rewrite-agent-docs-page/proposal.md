## Why

The page is now the destination of the For AI menu's last entry, and it answers a narrower question than the menu implies. It is a procedure for one thing — reading a project's installed version and resolving the matching documentation line — written for coding agents, with a note telling humans to use the version switcher instead.

Meanwhile the site offers five things to an agent, and four of them are documented nowhere a reader can find. There is a resolver index and a full corpus at three levels each, an assistant scoped to the reader's line, Markdown of every page reachable two ways, and an MCP server. A reader arriving from the menu is shown one of those five and cannot discover the rest.

The page should be the answer to "what does this site give an AI agent, and how do I use each one". The line-resolution procedure is one section of that answer, not the whole page.

## What Changes

- The page is rewritten end to end. It opens by naming the five things the site offers an agent, then takes each in turn: what it is, how to use it, and where the versioned collections change how it is used.
- It addresses the reader directly, whether that reader is a person or an agent, rather than writing for agents with an aside for humans.
- Line resolution moves into a section of its own at the end, covering what a reader must be careful about because several collections are versioned, rather than being the page's subject.
- Everything not needed to *use* one of the five is cut. The page explains no mechanism for its own sake.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-entry-points`: gains a requirement on what the page must cover, alongside the existing one on what it must be named. The menu leads there, so the page has to answer for everything the menu implies exists.

## Impact

- `content/docs/resources/docs-for-ai-agents.mdx` — rewritten.
- No change to any artifact, to the cascade, to the menu, to metadata, or to any URL. The page describes what already exists; nothing it describes is being built here.
