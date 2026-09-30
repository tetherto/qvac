# Solutions editorial contract

The standard every page in the `Solutions` collection follows. The author does not have to remember it; this file is the authority the skill applies.

## What a Solution is

A Solution documents reusable knowledge extracted from a real scenario. It answers one question:

> Given this kind of scenario, how should QVAC be used to address it?

The specific content that triggered the investigation gets generalized. The page is never written as a report about one customer or partner. A case that started with a bank running an NVIDIA A10 becomes:

```text
Run QVAC on NVIDIA server GPUs
```

and not:

```text
How we deployed QVAC for Bank X
```

It is also not a defect catalog. A page that diagnoses a crash, a missing system library, or a failing environment belongs in `docs/website/content/docs/troubleshooting.mdx` instead.

The page preserves the relevant characteristics of the scenario, the ones that let another developer conclude:

> "This case looks like mine."

## Frontmatter

Every Solution page uses the standard QVAC Docs frontmatter:

```yaml
---
title: <title>
description: <description>
---
```

### title

The `title` identifies, briefly and recognizably, **the recurring scenario or task the Solution covers**. Prefer concrete, task-oriented titles.

```yaml
title: Run QVAC on NVIDIA server GPUs
```

```yaml
title: Replace Ollama with QVAC
```

```yaml
title: Build a read-only assistant over a REST API
```

The title must let a developer or an AI agent answer immediately:

> Which case does this page cover?

Never title the page after the customer, partner, or engagement.

### description

The `description` is a single short sentence. It does not merely restate the title. Its job is to **qualify the scenario and supply enough context for a human or an agent to judge quickly whether the page is relevant**.

It may add, as needed:

- scope;
- environment;
- audience or context;
- condition of application;
- the central characteristic of the solution;
- the nature of the knowledge the page holds.

```yaml
title: Run QVAC on NVIDIA server GPUs
description: Requirements, deployment considerations, and validated performance for running QVAC on NVIDIA server GPUs.
```

```yaml
title: Replace Ollama with QVAC
description: API compatibility, migration considerations, and required changes when replacing Ollama with QVAC.
```

```yaml
title: Build a read-only assistant over a REST API
description: Architecture guidance for connecting a local model to an existing REST API while keeping execution under application control.
```

`title` plus `description` has to work as a strong relevance signal for search, navigation, and AI agents.

Do not add a second summary or description at the start of the body. The frontmatter already fills that role, and the page component renders the description under the title.

### Repository frontmatter fields

Optional, and shared with the rest of the site:

- `schemaType` — set `HowTo` when the page walks through steps. Leave unset for architectural guidance; it defaults to `TechArticle`.
- `tocMaxDepth` — lower it when a deep page produces a noisy table of contents.
- `ogImage` — only when a static social image exists for the page.

## Page structure

After the frontmatter and the elements the site renders automatically — title, description, table of contents, page actions — the conceptual structure is:

```md
## Scenario

...

## Recommended approach

...

## <free-form technical sections>

...

## Considerations

...

## Tested with

...

## Related resources

...
```

Not all of those headings are mandatory. The rules below decide which ones apply. Omit an optional section entirely rather than shipping it empty.

## Scenario

`Scenario` is required. It answers:

> In what situation does this Solution apply?

This is one of the most important parts of the content type, because it preserves the external context that produced the knowledge in the first place.

The section describes the state of the problem **before a solution was chosen**. It may include, as relevant:

- the goal of the developer or company;
- technical environment;
- infrastructure;
- hardware;
- existing software;
- integration context;
- requirements;
- constraints;
- security requirements;
- compatibility requirements;
- performance requirements;
- operational constraints;
- the conditions that decide when the Solution applies.

Fixed subheadings such as `Goal`, `Environment`, or `Constraints` are not required. Use prose and bullets, whichever fits.

```md
## Scenario

You want to run QVAC as a local model provider on Linux x86_64 infrastructure using NVIDIA data-center GPUs.

The deployment may need to:

- run inside containers;
- support one or more QVAC instances per host;
- use CUDA-enabled NVIDIA GPUs;
- serve 8B-class models with predictable performance.
```

Editorial rule:

> `Scenario` describes the context and the conditions that existed before the solution was chosen.

## Recommended approach

`Recommended approach` is required. It answers:

> Given that scenario, what is the recommended way to address it with QVAC?

This section presents the solution at the level of strategy and design, ahead of specific technical detail. It may include:

- the main approach;
- structural decisions;
- conceptual architecture;
- division of responsibilities;
- boundaries;
- the fundamental choices;
- the rationale behind those choices.

The reader should finish the section thinking:

> "I understand which strategy QVAC recommends, and why."

They do not necessarily need enough information to implement all of it yet.

```md
## Recommended approach

Use the model to interpret the user's request and select from a restricted set of predefined operations.

Keep API execution in deterministic application code. The model should not construct or execute arbitrary API requests directly.

This separates model reasoning from system authority and keeps the application responsible for validation, authorization, and execution.
```

Editorial rule:

> `Recommended approach` explains **what to do and why**.

The detail of how to apply the solution technically belongs to the sections that follow.

## Free-form technical body

After `Recommended approach`, the free-form part of the Solution begins.

There must be no mandatory heading called:

```text
Implementation
```

or any equivalent. Headings are chosen according to the specific content of the Solution.

Example for a GPU / server deployment:

```md
## GPU support

## Container requirements

## Running multiple instances

## Performance
```

Example for a migration:

```md
## API compatibility

## Configuration changes

## Migration steps
```

Example for an architectural Solution:

```md
## Architecture

## Defining allowed operations

## Executing API requests

## Security boundaries
```

Headings must be specific and semantically useful. Prefer:

```text
GPU support
Container requirements
Security boundaries
API compatibility
```

over generic headings such as:

```text
Details
More information
Implementation details
Additional information
```

This principle matters particularly for making the content easy to retrieve and interpret for AI agents.

Editorial rule:

> After `Recommended approach`, use sections specific to the case to explain how the solution works or is applied in practice.

## Considerations

`Considerations` is a standardized heading, but optional.

Use it when there is relevant knowledge about:

- tradeoffs;
- limitations;
- edge cases;
- pitfalls;
- operational concerns;
- security implications;
- constraints;
- alternatives;
- behavior that is not obvious;
- anything the developer should weigh before adopting the solution.

The section may carry its own subsections when needed:

```md
## Considerations

### GPU memory

...

### Multiple instances

...
```

Do not create the section when there is no relevant content.

## Tested with

`Tested with` is a standardized heading, but optional.

Use it when the Solution was empirically verified through:

- tests;
- proofs of concept;
- benchmarks;
- a real deployment;
- specific hardware;
- specific models;
- specific versions;
- measurements;
- experimentation.

The section must make clear **what was effectively tested**, separating recommendations or expected behavior from proven behavior. Name the versions, hardware, model, and quantization behind every number. Attribute a third-party measurement as such, with the environment it came from. Never publish a figure that was not measured.

The default shape is a lead-in sentence followed by the list of what was exercised, then any measurements. Adapt it when the content calls for something else:

```md
## Tested with

This solution was tested with:

- QVAC x.y.z
- Linux x86_64
- NVIDIA A10 24 GB
- NVIDIA driver ...
- Model ...
- Quantization ...

Observed throughput:

| Model | Quantization | Context | Tokens/s |
| --- | --- | --- | --- |
| ... | ... | ... | ... |
```

Do not create `Tested with` when there is no concrete, relevant validation.

## Related resources

`Related resources` is standardized, but optional.

Use it to point the reader at what they need next. The name is deliberate: an entry may lead to another page in the docs website, and it may lead somewhere outside it.

Inside the docs website, connect the Solution to the foundational QVAC documentation, such as:

- SDK docs;
- CLI docs;
- model provider docs;
- package docs;
- backend docs;
- API reference;
- related concepts.

Outside the docs website, link whatever the Solution genuinely depends on, such as:

- a published package on npm or PyPI;
- a repository, example, or template;
- a public issue or pull request that records the diagnosis or the decision;
- a model card or a page on a model host;
- the documentation of a third-party product the integration involves;
- an upstream specification or standard.

A Solution must not needlessly duplicate existing documentation. When foundational detail is already documented elsewhere, summarize only what is needed to understand the Solution and point to the canonical source.

Internal links are absolute, site-root paths without a `/docs` prefix — for example `/cli/http-server`. External links are full URLs, and every one of them must be public and durable. Never link private infrastructure, an internal document, or anything behind company authentication.

## Formal schema

The formal structure of the collection is:

```text
TITLE                              required, frontmatter

DESCRIPTION                        required, frontmatter

SCENARIO                           required

RECOMMENDED APPROACH               required

------------------------------------------
FREE-FORM TECHNICAL BODY
------------------------------------------

CONSIDERATIONS                     optional, standardized

TESTED WITH                        optional, standardized

RELATED RESOURCES                  optional, standardized
```

## Semantic layering

When generating a page, preserve this division:

```text
Title
→ Which recurring case does this page cover?

Description
→ What additional context lets me judge quickly
  whether this page is relevant?

Scenario
→ In exactly which situation does this Solution apply?

Recommended approach
→ Which strategy does QVAC recommend for that situation, and why?

Free-form technical body
→ How does this solution work or get applied in practice?

Considerations
→ What has to be taken into account?

Tested with
→ What was effectively tested or measured?

Related resources
→ Where is the canonical documentation for the components involved,
  and what else, inside or outside the docs, does this Solution rely on?
```

Avoid duplicating content across those layers. Each one must add new information.

## Writing for AI agents

A significant share of this content is consumed by AI agents. Prioritize:

- semantically explicit titles;
- descriptions with a strong relevance signal;
- specific headings;
- direct language;
- a predictable structure;
- explicit applicability information in `Scenario`;
- clear references to canonical documentation;
- a clear separation between recommendation and empirical validation;
- clean Markdown that is easy to retrieve.

Do not sacrifice the human experience for agents. The structure has to work well for both.
