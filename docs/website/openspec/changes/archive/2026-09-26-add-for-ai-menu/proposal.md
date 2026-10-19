## Why

The site publishes a lot for coding agents and tells a reader about almost none of it. There is an MCP server, a resolver index at `/llms.txt`, a full corpus at `/llms-full.txt`, a corpus per collection, a corpus per documentation line, a Markdown twin of every page, and a page explaining the protocol for choosing among them. From the navbar, none of that is reachable. A reader who wants to point an agent at these docs has to already know the URLs.

That gap was not an oversight in the design, only in the build: `collection-navigation` already describes a navbar that offers "the For AI entry", so the spec currently describes a menu the code does not render. This closes that.

The page the menu leads to is also misnamed for this purpose. It is called *Build with AI*, which reads as a tutorial on building AI features — and this site does document building AI features, in the SDK's `ai-capabilities` section. The page is not about that. It tells an agent how to pick the right documentation line for the release a project has installed. *Docs for AI agents* says what it is, and stops competing with the SDK pages for the same reader.

## What Changes

- The navbar gains a **For AI** menu, beside the assistant, holding four entries:
  - **Connect the MCP server** — copies the server's address, which is what a reader pastes into an agent's configuration. It is not opened: the address is an endpoint, not a page, and a browser makes nothing of it.
  - **Open /llms.txt** — the site's resolver index.
  - **Open /llms-full.txt** — the site's full corpus.
  - **Use QVAC docs with AI agents** — the page explaining how an agent picks a line.
- The two artifacts are the site-wide ones, the top of the cascade. Each already routes an agent down to a collection's and a line's own, so the menu offers one entry point rather than a list that grows with every line cut.
- The page at `/resources/build-with-ai` is renamed *Docs for AI agents* and moves to `/resources/docs-for-ai-agents`. It has never been served in production, so nothing needs to keep redirecting from the old address.

## Capabilities

### New Capabilities

- `agent-entry-points`: how a reader is handed the means to point an AI agent at this documentation — what the menu offers, why each entry behaves as it does, and the gate that keeps every entry resolving.

### Modified Capabilities

- `docs-collections`: the scenario naming the Resources page as *Build with AI* at `/resources/build-with-ai` is restated for its new name and address.

## Impact

- `src/app/(docs)/layout.tsx` — the menu is added to the navbar's items.
- A new component for the menu, holding the clipboard action for the MCP address.
- `src/lib/artifacts.ts` — the constant naming the page's URL, which every corpus header and every line index cites.
- `src/lib/custom-tree.ts` — the page's sidebar entry.
- `content/docs/resources/build-with-ai.mdx` — renamed, with its title and description.
- `tests/` and `scripts/` — the two tests naming the old URL, and a check that the menu's entries resolve.
- No change to any artifact's content, to the cascade, or to any other page's URL.
