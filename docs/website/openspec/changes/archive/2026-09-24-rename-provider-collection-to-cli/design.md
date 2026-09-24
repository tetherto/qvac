## Context

The site publishes four collections, two of them versioned. The SDK's lines follow `@qvac/sdk`; the Provider's follow `@qvac/cli`, because the package that implements the OpenAI-compatible HTTP server is the CLI. That anchor is already the admission this change acts on: the collection is named after a feature of the package it tracks.

The CLI's documentation is currently split. `content/docs/sdk/(v0.19)/cli.mdx` — install steps, the config generator, SDK bundling, the requirements check, and a command reference for `qvac bundle sdk`, `qvac serve`, `qvac configure`, `qvac openai spec`, and `qvac doctor` — sits in the SDK's lines. The three HTTP server pages sit in the Provider's lines. The split is not native to the site either: the move map from the reorganization records that `cli/index.mdx` was served at `/cli` and `cli/http-server/**` at `/cli/http-server/**`, in one folder. That is still what production serves. Neither the collections nor the lines have shipped to either deployed environment: `docs-production` and the `main` staging branch both carry the flat tree and a `_redirects` that already sends `/http-server/` to `/cli/http-server/`. The split exists only on this branch, where six generated rules point those `/cli` addresses at `/provider`. The rename is therefore not only a correction of the branch's model; it is a return to the addresses the site publishes today.

Two declarations define a collection. `src/lib/custom-tree.ts` holds its name, description, and path for the collection bar; `src/lib/versions.ts` holds the manifest entry binding its lines to a package and a path. Page attributes, retrieval filters, the line switcher, and the agent artifacts all derive from those, so a collection's identity has exactly two places to change.

## Goals / Non-Goals

**Goals:**

- Name the collection after the software it documents, so its lines and its name follow the same package.
- Put the CLI's documentation in one collection, reachable from one place in the navigation.
- Keep every URL production serves resolving, and keep the build's own gates as the proof.
- Restore `/cli` and `/cli/http-server/**` as real pages rather than redirects.

**Non-Goals:**

- Rewriting the CLI page. Its HTTP server summary overlaps the HTTP server pages it now sits beside; reconciling them is editorial work for a later change.
- Re-cutting either collection's lines. The CLI keeps `(v0.13)` and `v0.12`, the SDK keeps `(v0.19)` and `v0.18`.
- Introducing the collection the target information architecture anticipates for applications or research.
- Changing what the model provider is called on the page. Only the collection is renamed.

## Decisions

**The rename is a move, not a label change.** The collection folder becomes `content/docs/cli`, the manifest path becomes `/cli`, and the `/provider/**` addresses stop existing. The alternative — keeping `/provider` as the path and changing only the display name in the collection bar — was rejected because the path is not decoration. It is the canonical URL, the prefix agents read out of `llms.txt`, the value of the `inkeep:collection` attribute that scopes retrieval, and the segment the artifact gate uses to prove no line leaks into another. A collection whose name and path disagree would make every one of those surfaces say something different from the navigation.

**The CLI page becomes the collection index.** `content/docs/sdk/(v0.19)/cli.mdx` becomes `content/docs/cli/(v0.13)/index.mdx`, and the SDK's `v0.18` copy — identical today — becomes `content/docs/cli/v0.12/index.mdx`. This is the layout the site had before the reorganization, down to the address: `/cli` served that page. A hub page was considered, with the CLI page kept as a child, but it would invent a page to introduce a collection that already opens with an overview and install steps, and it would leave `/cli` as something other than what it used to be.

**The Provider overview is retired rather than moved.** It is a title, two sentences, and three cards pointing at the HTTP server pages. The sentences describe the model provider, which the CLI index already introduces as one of the tool's functions, and the cards move onto the CLI index. Keeping it as a second overview inside the same collection would give the collection two front doors.

**The moved page changes what it is versioned against.** Today it carries SDK numbers while documenting a tool released on its own cadence, so `/sdk/v0.18/cli` labels CLI documentation with an SDK release. After the move it carries `@qvac/cli`'s numbers, which is the whole argument of the change. The consequence is that `/sdk/cli` and `/sdk/v0.18/cli` stop being page URLs, and leave nothing behind: production has never served them.

**The rules are deleted, not reversed, and no rule replaces them.** The six sending `/cli/http-server*` and their Markdown twins to `/provider`, and the two sending `/cli` to `/sdk/cli`, become loops the moment those addresses are pages again. All eight are generated, so correcting the move map — the CLI pages keep their URLs — removes them without a hand edit. What is deliberately *not* added is the mirror image: a `301` from each `/provider/**` address and from `/sdk/cli`. Those addresses have never been served, so a rule for them would protect no reader and would assert, in the one file that records the site's URL history, a move that never happened. The build proves the result rather than the intent: `check-redirects.ts` fails on a rule whose `from` is a live page — it calls them shadowed — and separately on any `301` whose destination no longer resolves, which catches anything still pointing into `/provider`. The two URL inventories are replayed with their existing budgets, and the rename costs no page a hop on either.

**This change is archived after `version-docs-by-collection`.** Its deltas modify requirements that the versioning change publishes — that the Provider's lines are `(v0.13)` and `v0.12`, that every page of a versioned collection sits inside a line. Archiving in the other order would apply a modification to a requirement that does not exist yet.

## Risks / Trade-offs

**"Model provider" loses its place in the navigation** → It was a collection in the bar and becomes a section inside one. This is the trade the change accepts deliberately: the audience cut was clearer, the software cut is maintainable. The term survives where readers and retrieval actually meet it — the CLI index introduces it, the cards name it, and the HTTP server pages keep their titles and their text, so a search for it returns the same pages it returns today.

**A link to a branch preview breaks** → `/provider/**` and `/sdk/cli` stop resolving with no redirect behind them, so a URL copied out of a preview deployment or a review thread 404s. Accepted: the audience is this branch's reviewers, the content is one collection away, and the alternative is twenty-one CDN rules standing for a migration readers never went through.

**The CLI index and the HTTP server pages overlap** → The index summarizes `qvac serve` and links into the HTTP server pages for configuration; both now live in the same collection, where the duplication is visible rather than hidden across a collection boundary. Left as is by design, and named as a non-goal so the next editorial pass has it written down.

**Two changes in flight touch the same specs** → The ordering requirement is stated in the proposal, in this design, and as the last task, and `openspec validate --strict` runs against both before either is archived.
