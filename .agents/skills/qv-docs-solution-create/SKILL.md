---
name: qv-docs-solution-create
description: Creates a Solutions page in the QVAC documentation website from a real use case, generalizing the case into reusable guidance and registering the page in the site navigation. Use when a developer, company, or partner scenario the expansion team supported should become published documentation, or when invoking /qv-docs-solution-create.
disable-model-invocation: true
---

# Solutions Page Create

Publish one page in the `Solutions` collection of the documentation website.

Most documentation is written from the inside out: a feature exists, so it gets documented. Solutions works from the outside in. Someone brings a real scenario, the expansion team works through it with them, and the generalized answer becomes a page the next person with a similar scenario can reuse. The collection exists so that knowledge stops living only in chat threads, proofs of concept, and calls.

The expansion team writes most of these pages. The docs owner maintains this skill and the collection's editorial standard, so an author never has to remember the structure.

Read before drafting:

- [references/editorial-contract.md](references/editorial-contract.md) — the frontmatter rules, the required and optional sections, and the heading conventions of this collection.
- `docs/website/AGENTS.md` — the authoring rules the website package sets for its own content and source.
- `docs/website/README.md` — the framework, content layout, build, and automation the package owns.

Defer to the package's own sources for anything about the site itself; this skill defines only what is specific to `Solutions`. Reuse the conventions the project already has, and never introduce a new abstraction where an existing one fits. Fill [assets/solution-template.mdx](assets/solution-template.mdx).

## Scope gate

Two checks run before drafting. Both must pass.

The first check classifies the material. Solutions documents how to build, deploy, or integrate something with QVAC. It is not a defect catalog.

Draft a Solution when the material is a use case: someone set out to achieve something with QVAC, and the recommended way to do it is now known.

If the material is a defect, a crash, an error message, a missing system library, an environment that fails to start, or a regression, do not draft a Solution. That knowledge belongs in `docs/website/content/docs/troubleshooting.mdx`, which already carries the Situation / Cause / Solution shape for it. Say so and stop.

If the material is setting up or building an app on a platform the docs already teach, do not draft a Solution. That knowledge belongs in the matching tutorial — `docs/website/content/docs/tutorials/electron.mdx` for Electron, `docs/website/content/docs/tutorials/expo.mdx` for Expo. Say so and stop.

If the material is an unresolved product gap with no working approach yet, recommend an issue instead of a page.

A Solution may state a known limitation and the architecture that works around it, as long as the subject of the page is the use case and not the defect.

A Solution may run on a platform a tutorial covers, as long as the subject of the page is the use case and not the platform setup. Link the tutorial under `Related resources` rather than repeating it.

The second check tests the objective against the site as it already is. State in one sentence the objective the page would serve, phrased as the reader's goal. Then search `docs/website/content/docs/` for a page that already serves that same objective, by title, by description, and by content.

If a page already fulfills exactly that objective, do not draft a Solution. Name that page and stop. Propose extending it instead when the material adds something the page lacks.

Overlapping subject matter is not a reason to stop. Solutions indexes the documentation by scenario, while the rest of the site indexes it by surface, so the same facts legitimately appear on both axes. Only an identical objective blocks the page. Never restate a specification another page owns — summarize what the Solution needs and link that page under `Related resources`.

## Ground the page

The source material is the trigger for the page, not its source of truth. A thread records what was believed when it was written, and the product moves. Re-verify every technical claim at the time of writing against:

- the current package manifests and source in this repository;
- the documentation pages the Solution will rely on;
- the release notes and API reference for the versions involved;
- the current state of any referenced issue or pull request, via `gh`.

Correct the material wherever the repository contradicts it. Never carry a workaround into a page after the fix has shipped. State no roadmap or forthcoming-support claim, and no performance figure that was not measured.

## Intake and readiness

The material behind a Solution can arrive as any of these, alone or combined:

- chat threads;
- technical investigation;
- proofs of concept;
- tests;
- benchmarks;
- conversations with developers;
- context given directly in the prompt;
- code and configuration present in this repository;
- existing documentation.

Ask only for what is missing, one question at a time unless the author asks for a batch. A Solution is ready to draft when these are known:

- what the developer or company was trying to achieve;
- the environment, constraints, and requirements that decide when the page applies;
- the recommended approach and why it is preferable;
- which QVAC surfaces it involves, such as SDK API, CLI, HTTP server, addon, or model;
- what was tried and did not work, when that shaped the approach;
- what was actually tested, and on which hardware, model, quantization, and version.

If the recommended approach or its rationale would have to be invented, stop and ask. Label every assumption the author still has to confirm.

## Generalize the case

Prioritize generalizing the knowledge over turning a conversation into text. Move the material along one ladder:

```text
specific case
        ↓
relevant constraints
        ↓
generalizable scenario
        ↓
recommended QVAC solution
```

For example, this is useful context during the investigation:

```text
Partner X uses four NVIDIA A10 GPUs on Oracle Cloud in Saudi Arabia.
```

The published page generalizes it to something like:

```text
Linux x86_64 server infrastructure using NVIDIA data-center GPUs.
```

Remove what only identifies the engagement: the customer or partner name, account and tenant identifiers, internal identifiers, private infrastructure, and individual names. Attribute nothing to a person; cite public issues and pull requests by number instead.

Keep the named third-party platforms and products the scenario depends on — the cloud or hosting provider, the model host, the model or API vendor, the tool being replaced. Naming them is what makes an integration legible: a page that says "a cloud provider" where it means AWS or Vercel, or "a model host" where it means Hugging Face, is harder for both a reader and an agent to match against their own stack.

Keep the technical characteristics that let another developer recognize their own case. Every other specific detail — hardware model, instance type, region, version — survives only when it is technically relevant to the approach.

In the example above the provider and the region drop out because nothing in that approach depended on them. Had the approach turned on a provider-specific instance type, image, or driver stack, the provider belongs on the page.

## Write the page

Write in English. Create one file per Solution at `docs/website/content/docs/solutions/<kebab-slug>.mdx`, following the editorial contract. The directory already exists and carries no landing page. If that path already exists, stop and ask whether to update it; do not overwrite.

Draft in this order:

1. identify the generalizable scenario;
2. separate the customer or partner specifics from what actually defines the use case;
3. produce the title;
4. produce the one-sentence description;
5. write `Scenario`;
6. write `Recommended approach`;
7. decide which case-specific technical sections the Solution needs;
8. add `Considerations` when there is real knowledge to weigh;
9. add `Tested with` only when there is concrete evidence;
10. add `Related resources` when there are relevant pages in the docs or public material outside them;
11. create the file in the collection directory;
12. register the page so it appears inside `Solutions`.

Keep code examples executable and free of private infrastructure. Reuse the MDX components the surrounding pages already use instead of inventing markup. Where fundamentals are documented elsewhere, summarize only what the Solution needs and link the canonical page.

## Register the page in the navigation

`Solutions` exists as four things and nothing more: a sidebar entry, a directory in the content structure, a URL segment, and a breadcrumb element. Individual pages appear directly inside it:

```text
Solutions
  Run QVAC on NVIDIA server GPUs
  Replace Ollama with QVAC
  Build a read-only assistant over a REST API
```

The sidebar is a hand-written tree in `docs/website/src/lib/custom-tree.ts`. The filesystem does not drive navigation and the site has no `meta.json`, so a page left out of the tree resolves as a URL but appears nowhere.

If the tree has no `Solutions` node, create one in the `Help` section, after the `Troubleshooting` page and before the external `Discord` link:

```ts
{
  name: 'Solutions',
  type: 'folder',
  icon: resolveIcon('Compass'),
  children: [
    { name: '<page title>', url: '/solutions/<kebab-slug>', type: 'page' },
  ],
},
```

Omit `index`. A folder without one renders as a group label in the sidebar and as plain text in the breadcrumb, which gives `Solutions` both a navigation entry and a breadcrumb position without a landing page of its own. Never add `content/docs/solutions/index.mdx`.

If the node already exists, append the page to its `children`.

Keep the collection flat, with pages as direct children. Do not create subcategories such as `Deployment`, `Architecture`, or `Integration`. The tree supports them whenever content volume justifies it, and that call belongs to the docs owner.

Site URLs carry no `/docs` prefix, so the page registered above serves at `/solutions/<kebab-slug>`.

## Validate

Run from `docs/website`, using its manifest scripts:

```bash
bun run vitest run tests/sidebar-consistency.test.ts tests/link-integrity.test.ts
```

- `tests/sidebar-consistency.test.ts` fails when a navigation entry has no content file.
- `tests/link-integrity.test.ts` fails on a broken internal link.
- Run `test:examples` when the page carries TypeScript, JavaScript, or Python blocks.
- Run `build` before handoff; it also runs the broken-link pass over the built site.

Report any check that cannot run.
