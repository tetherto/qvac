## Context

What the site publishes for agents is a three-level cascade. The site's `/llms.txt` resolves to a collection's; a collection's resolves to a line's; a line's index lists that line's pages and its corpus. `/llms-full.txt` mirrors that at every level, and the root one carries the unversioned pages plus the current line of every versioned collection — 70 pages, the set an agent wants when it has no particular release in mind.

That structure is why the menu names only the two root artifacts. Offering a corpus per line would put six entries in the menu today and one more on every line cut, and each of those is already one hop from the root index, which exists to make that hop. The menu is the entrance to the cascade, not a directory of it.

The MCP server is at `https://mcp.inkeep.com/tetherio/mcp`, hosted by the same provider as search and the assistant, so the knowledge base behind it is the one this site already feeds.

`/resources/build-with-ai` was itself renamed once, from *Corpus protocol*, in the Ecosystem and Resources restructure. It is not in `tests/fixtures/pre-move-urls.json` and there are no `/resources/*` URLs there at all, so the page has never been served in production and the redirect machinery has nothing to preserve.

## Goals / Non-Goals

**Goals:**

- Make the agent-facing surface reachable without knowing a URL.
- Give the MCP address the form a reader actually needs it in.
- Name the protocol page for what it does, so it stops reading as an SDK tutorial.
- Gate every entry, so the menu cannot come to point at something that has moved.

**Non-Goals:**

- Line-aware entries. A reader inside `/sdk/v0.18` is not offered that line's corpus. The root index resolves it, and a menu whose contents changed with the reader's position would be a second, weaker version switcher.
- Anything about the assistant or search, which are the same provider's surfaces but a different job: they answer a question here, the menu hands the documentation elsewhere.
- Documenting how to configure an MCP client. The page the menu's last entry leads to is where that belongs, and it is out of scope here beyond the rename.

## Decisions

### The MCP entry copies rather than opens

`https://mcp.inkeep.com/tetherio/mcp` is an endpoint. Opening it in a tab gives a reader a stream or an error, never something to read. What they want is the address itself, pasted into an editor's configuration.

So the entry copies, and says so on completion. The site already does this for a page's Markdown: `CopyPageButton` fetches, writes to the clipboard, and swaps its icon for a tick on a timer. The menu entry follows the same shape, without the fetch — the address is a constant.

The entry's label is *Connect the MCP server* rather than *Copy the MCP address*, because the address is the means and connecting is the errand. The tick says what happened.

### Only the root artifacts appear

Considered and rejected: a submenu per collection, and entries that follow the reader's current line. Both were rejected for the same reason — the cascade already resolves downward, and the resolution is the part an agent is good at. A reader who opens `/llms.txt` and hands it to an agent has given it everything, including how to find the line matching the release their project has installed. A menu that pre-resolved that would be guessing at which release the reader means, which is the question the protocol page exists to answer properly.

The user's original sketch grouped the two under an *LLMs files* label. Dropped: with two entries and no third coming, the label was a heading over a list short enough to read without one.

### The page is renamed, not redirected

The rename touches more than the file. `BUILD_WITH_AI_URL` in `artifacts.ts` is cited in every corpus header and every line index, so the URL appears in all 18 published artifacts; `custom-tree.ts` holds the sidebar entry; two tests name it. All of them move together, and the build's own leakage and artifact checks verify the result — a stale URL in an artifact fails `check-artifacts.ts`, which resolves every URL it finds.

No redirect is added. The page has never been served at either address in production, and adding a redirect for a URL that was only ever on a branch would be adding a rule nothing can retire.

### The gate is split, because the built page holds only half the menu

This was written expecting the menu's entries to be in the built HTML. They are not, and the implementation is what showed it: the framework renders a menu's contents into a Radix popover, which mounts on open, and the narrow-viewport rendering is a collapsed folder whose content element is emitted empty. The entries appear in exactly one place in the build — Next's serialised RSC payload, as escaped JSON.

Parsing that payload was considered and rejected. It is the built output, and it does carry the entries, but it is an internal serialisation format: a Next upgrade could change it, and the gate would then be asserting against a shape nobody maintains.

So the gate is split, each half holding what it can actually see:

- The entries are declared as data in `lib/for-ai-menu.ts`, and `tests/for-ai-menu.test.ts` asserts their shape — the four in order, the MCP entry with no URL, the page entry carrying `AGENT_DOCS_URL` rather than a literal.
- `check-navbar-links.ts` asserts the trigger, on every page it samples and in every rendering of the navbar on it, and that each is a button rather than a link.

URL resolution needs neither: `/llms.txt` and `/llms-full.txt` are the artifacts the artifact check already resolves, and `AGENT_DOCS_URL` is cited in all 18 of them, so a page that stopped resolving would fail there first.

What no gate covers is the clipboard itself, a runtime interaction with no trace in any artifact. The nearest observable proxy — that the entry is not a link — is asserted, since that is the failure that would matter.

### The trigger is checked in every rendering, not the first

A page carries the navbar twice: once for a wide viewport, once inside the navigation a narrow one opens. Checking only the first occurrence let a mutation test pass that should have failed, because the second rendering covered for the first. Every occurrence is checked, so a trigger lost or linkified in one rendering is not masked by the other.

## Risks / Trade-offs

**A menu in the navbar competes with the assistant beside it** → They read as one cluster and answer adjacent questions, which is the argument for placing them together rather than apart. The risk is a reader who wants to ask a question clicking the wrong one; the labels differ plainly, and the menu's entries make its purpose obvious the moment it opens.

**The MCP address is a constant in this repo** → It is a public endpoint, not a secret, and it is the provider's stable address. If it moves, the menu is wrong and nothing fails, because no build check can verify a third-party endpoint without calling it. Accepted: the alternative is a network call in the build, which would make the build fail on the provider's outage.

**Renaming a page that 18 artifacts cite** → All the citations come from one constant, and the artifact check resolves every URL it publishes, so a missed one fails the build rather than shipping. The real exposure is external links to the old URL, and there are none: the address has never been public.

**The page's new name overlaps with the SDK's AI capabilities section** → It overlaps less than the old one. *Build with AI* and `ai-capabilities` describe the same activity; *Docs for AI agents* describes documentation, which is what the page is about.
