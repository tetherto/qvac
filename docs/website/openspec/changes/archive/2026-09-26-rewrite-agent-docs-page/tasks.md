## 1. Write the page

- [x] 1.1 Replace the description with what the page is for: what this documentation offers an AI agent, and how to use each of it.
- [x] 1.2 Open with an overview naming the five resources, and nothing else.
- [x] 1.3 Write one section per resource, in the overview's order, each saying what it is for and how to use it, and how the versioned collections change that where it is not evident.
- [x] 1.4 Close with the versioning section: what a line is, how to resolve the one matching a release, what to do when none matches, and the rule against mixing two lines of one collection.
- [x] 1.5 Address the reader directly throughout, marking in place the few instructions that differ for a person and an agent.

## 2. Cut

- [x] 2.1 Read every unit of information and keep it only if a reader needs it to use one of the resources; rewrite or remove the rest.
- [x] 2.2 Confirm nothing explains how the site is built.

## 3. Verify

- [x] 3.1 Check every address the page cites against the built site.
- [x] 3.2 Confirm the page does not contradict the guidance the root index carries for an agent that never reaches it.
- [x] 3.3 Run `npm run build` and confirm every check passes, including the link check and the artifact check.
- [x] 3.4 Run `npm test` and confirm the suite passes.

## 4. Land it

- [x] 4.1 Validate the change with `openspec validate rewrite-agent-docs-page --strict` and archive it.
- [x] 4.2 Check the published `agent-entry-points` spec after archiving.
- [x] 4.3 Commit the whole change as one commit.
