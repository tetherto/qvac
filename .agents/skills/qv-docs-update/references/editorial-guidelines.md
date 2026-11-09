# Editorial guidelines

Every rule below is a pattern the current pages already follow. Obey them and the patch reads like the page it lands in.

The sections up to "SDK conventions" apply to every software. The sections from there on describe the SDK's pages; for any other software, follow its own pages the same way: read the closest sibling of the page you are writing, and match it.

Where the corpus is inconsistent, this file says so. Match the page you are editing. Never normalise a neighbour.

URLs are written as the site serves them: version-less, so a link resolves within whichever line the page is published in.

## Facts and prose never share a passage

Data components render the facts: `<SchemaTable fn>` the fields of a request, `<ModelsTable engines>` the models of an engine, `<FunctionReference>` a whole function, `<CliReference command>` a command's arguments and options, `<OpenApiReference>` the HTTP operations. Prose says what a reader does with them: when to reach for a field, how options interact, what to watch for.

- Never write a field list, a model list, an option table, or an operation list by hand. If a page needs one, use its component.
- Never repeat in prose what a component on the same page renders. Point at it instead.
- A missing description is fixed in the source schema, where every channel reads it, not in the page.

## Bindings

A hand-written page declares in its frontmatter every public symbol it describes:

```yaml
binds:
  - fn:translate
  - command:qvac serve
  - "endpoint:POST /v1/chat/completions"
```

Bind a symbol when the page's prose explains it, demonstrates it, or relies on its behaviour; that is what makes a change to it name the page. Do not bind a symbol a page only mentions in passing. Quote an identifier that holds spaces or braces. Generated pages bind nothing.

## Language and terminology

- Write in English only.
- Call the reader a **user**, never a "consumer". In an SDK context, "consumer" means other software. Use `user`, `users`, `user-facing`. This applies to the skill's own reports too.
- Address the user in the second person ("you control the session identity") or use the bare imperative ("Load any supported model"). Both are current.
- Use the present tense for behaviour. Describe what the code does, not what it will do.
- Write headings in sentence case: `## Text generation`, `### Concurrent completions`. Product and command names keep their own casing: `` ### `qvac serve` ``, `## HTTP server`, `## RAG`.

`text-generation.mdx` contains one violation: "so consumers don't have to parse tags from raw text". Do not copy it. Do not fix it either. A drive-by terminology correction is an editorial edit unrelated to the source change, and the Phase 6 diff review rejects it.

## Writing the patch

1. Write the smallest change that settles the target's `Reason`, then stop.

If the new text asserts something the `Reason` does not support, it is scope creep or hallucination. Write it again.

2. Correct a stale claim in place. Never rewrite a section to fix a sentence.

3. Preserve everything else byte for byte, including the corpus's existing inconsistencies: trailing spaces, `*` versus `-` markers, punctuation. A normalising diff buries the real change.

4. Ground every claim in the source: the regenerated data, the example file, a test, the model registry. If a claim cannot be grounded, then emit `HUMAN_INPUT_REQUIRED`. Never guess.

## SDK conventions

Page paths below are relative to the SDK's documentation root, `packages/sdk/docs/users/`.

Primary exemplars: `ai-capabilities/text-generation.mdx` is the richest page, `ai-capabilities/image-classification.mdx` the minimal canonical one.

## Page structure — `ai-capabilities/`

All 18 capability pages share this skeleton:

```text
frontmatter:  title, icon, description, schemaType: HowTo
## Overview
## Functions
## Models              (17/18 — rag.mdx has "## Pipeline" instead)
## Example | ## Examples
<Callout type="success"> footer tip   (17/18)
```

Use `## Example` for exactly one example. Use `## Examples` with one `###` subsection per example when there are several. Never wrap a single example in `## Examples`.

Place optional sections between `## Models` and `## Example(s)`, and only with evidence in the source. The ones observed are `## Features`, `## Enable the plugin`, `## Audio output`, `## Training`, `## Pipeline`, and `## Cancellation`. When in doubt, omit: a missing optional section is invisible, an invented one is wrong.

Frontmatter `title` capitalization is not normalized across the corpus (`Text generation`, `Text-to-Speech`). Follow the capability's own name.

Frontmatter `icon` is a Lucide export name, and it is what draws the page's sidebar entry: a versioned collection composes its navigation from the content, so the icon is declared here and nowhere else. A capability's icon must match the one its card renders on the Ecosystem overview. That card lives outside the documentation root, so a new capability's card is named in the report for the documentation owner.

Only capability pages get `schemaType: HowTo`. the CLI line's `index.mdx` uses `schemaType: TechArticle` and adds `ogImage`.

### `## Overview`

Open by naming the inference engine and linking its package. Then state the `modelType`. Then state the input and output shapes.

> Text generation uses [`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp) as inference engine. Load any supported model using `modelType: "llm"`.

> Image classification uses a **GGML** inference engine ([`@qvac/classification-ggml`](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml)). Load a model using `modelType: "classification"`.

### `## Functions`

Write an ordered list of the call sequence. Link each item to its reference page. Close with the fixed line.

```mdx
Use the following sequence of function calls:
1. [`loadModel()`](/sdk/reference/api/loadModel)
2. [`completion()`](/sdk/reference/api/completion)
3. [`unloadModel()`](/sdk/reference/api/unloadModel)

For how to use each function, see [SDK — API reference](/sdk/reference/api/).
```

Copy the closing line verbatim. It is boilerplate.

This shape belongs to capability pages only. Pages outside `ai-capabilities/` have their own, and imposing this one on them is a rewrite, not a patch. `runtime/logging.mdx` uses a numbered list with no preamble and items that describe roles. `runtime/cancellation.mdx` groups APIs by mechanism, so its list is not a call order. `ai-capabilities/world-simulation.mdx` adds a `###` subsection per function underneath `## Functions`.

Some pages annotate an item with a trailing em-dash note:

```mdx
1. [`loadModel()`](/sdk/reference/api/loadModel) — load with `modelConfig.parallel >= 2`.
```

A function's reference page is `/sdk/reference/api/<function>`, with the function's exact name: `assessModelFit()` links to `/sdk/reference/api/assessModelFit`. Take the name from the generated reference (`reference/api/`), not from the source filename: `completion-stream.ts` exports `completion`.

Link a symbol to its reference page whenever one exists. A link is for the reader; what routes a change to the page is its `binds`, so add the symbol there too.

### `## Models`

Prose explains which models the task takes: families, file layouts, engine choices. The models available as constants are data, rendered by `<ModelsTable engines={[…]} />` with the engines the task uses, after the lead-in `Models available as constants:`. Never list constants by hand.

Write the prose as either a sentence plus a `-` bullet list of cross-references, or a `-` list of families and their file layouts. Both are current.

> You can load any [`llama.cpp`](https://github.com/ggml-org/llama.cpp)-compatible text-generation/chat model. Model file format: `*.gguf`.

> Supported model families and their file layouts:
>
> - **MobileNetV3-Small**: single all-in-one `*.gguf` file — the base model or any fine-tune of the same architecture (converted to GGUF).

A few pages still close the section with a link to [SDK — Models](/sdk#models) instead of the table. Leave them as they are unless the target is that section.

### `## Features`

Write a bullet list, one entry per control or capability, short prose. Open each bullet with a short label, then a colon.

```mdx
* Event stream: `completion()` exposes a single ordered `events` async iterable plus an aggregated `final` promise.
* KV cache: cache and reuse the model's key/value attention state to speed up follow-up turns in long conversations.
```

This section uses `*` markers while `## Models` uses `-`. Match whichever the page already uses.

A new essential parameter on a documented function usually belongs here.

## Code examples

Never inline a full example. Always reference the file with `file=<rootDir>/…` inside `<Tabs>` / `<Tab>` / `<WrapCode>`. The nesting and the blank lines are exact.

````mdx
<Tabs>
<Tab value="js" label="JavaScript" default>
<WrapCode>

```js file=<rootDir>/packages/sdk/dist/examples/completion-events.js title="completion-events.js" lineNumbers
```
</WrapCode>
</Tab>

<Tab value="ts" label="TypeScript">
<WrapCode>

```ts file=<rootDir>/packages/sdk/examples/completion-events.ts title="completion-events.ts" lineNumbers
```
</WrapCode>
</Tab>

<Tab value="python" label="Python">
<WrapCode>

```python file=<rootDir>/packages/sdk-python/examples/completion_events.py title="completion_events.py" lineNumbers
```
</WrapCode>
</Tab>
</Tabs>
````

Rules that follow from that shape:

- Order the tabs `js` → `ts` → `python`, always. `js` carries `default`. If a capability has only a Python example, then that single tab takes `default`.
- Add the Python tab per example, not per page. Most `<Tabs>` blocks are JS + TS only. Add the tab where the `.py` file exists. Never add an empty tab for symmetry.
- Use the right path per language. The difference is not cosmetic, and the materializer rewrites each to the line's own snapshot:
  - `js` → `packages/sdk/dist/examples/<name>.js`, the build output of the `.ts`
  - `ts` → `packages/sdk/examples/<name>.ts`
  - `python` → `packages/sdk-python/examples/<name>.py`
- Leave the fence body empty. The MDX pipeline injects the file contents.
- Keep `lineNumbers` on every file-referenced block.
- Treat `title=` as editorial. It need not match the filename: `text-generation.mdx` references `tools/llamacpp-native-tools.ts` with `title="completion-tool-call.ts"`. When adding a tab to an existing `<Tabs>`, keep the title consistent with the sibling tabs.

`<Tabs>` is the pattern for runnable scripts, not a universal wrapper. `configuration/index.mdx` shows its schema with `<WrapCode>` and a single JSON fence, because there is one language and nothing to switch between.

Inline snippets are permitted where a whole runnable file would be noise. Observed uses: a call-shape illustration, a `loadModel({…})` recipe inside `## Models`, an event-loop pattern, a shell one-liner in the CLI line's `index.mdx`, and a sample of log output in a bare fence. The `kvCache` block is the model to follow:

````mdx
```js
completion({
  modelId,
  history,
  stream: true,
  kvCache: "user-123-session-a",
});
```
````

## The sentence before an example

Write exactly one introductory sentence, in the shape "The following script …".

> The following script shows how to handle each event type and read the aggregated result:

> The following script enables `kvCache: true` to speed up follow-up turns, and then compares it with `kvCache: false` on the same history:

> The following script loads a `parallel: 4` model, fires four completions at once, and then cancels one of two long runs to show its peer keeps decoding:

> The following script classifies a JPEG image using the registry MobileNetV3-Small model:

The sentence states what the script does, concretely, naming the parameters and values it demonstrates. It does not explain why the reader would want that.

Take that sentence from the example file's own top-of-file comment. That keeps the description and the script from drifting apart, and it is why a modified example routes to this sentence rather than to the whole section.

Trailing punctuation is inconsistent in the corpus, mostly `:` and sometimes `.`. Match the page.

When adding a Python tab to an existing `<Tabs>`, do not duplicate the introductory sentence. It already describes the example for every tab.

## Callouts

Use `<Callout type="…">` for caveats and asides, never for primary content.

| type | Used for |
| --- | --- |
| `info` | a caveat, a default-model disclosure, an API-preference note, the "Python example not yet published" disclosure |
| `success` | the footer tip, and occasional helper tips |
| `warn` | a hazard: hardware requirements, mutually exclusive parameters |

The `title=` attribute exists and is rare: `<Callout title="Coverage" type="info">` in `runtime/cancellation.mdx`.

Copy the footer tip verbatim. It is boilerplate.

```mdx
<Callout type="success">
**Tip:** all examples throughout this documentation are self-contained and runnable. For instructions on how to run them, see the [JS/TS quickstart](/sdk/js-ts-sdk#quickstart) or the [Python quickstart](/sdk/python-sdk#quickstart).
</Callout>
```

If a capability has no Python example, then declare it with this callout, verbatim, instead of staying silent.

```mdx
<Callout type="info">
The Python client supports this capability through the same worker. A dedicated Python example is not yet published — see the [Python SDK](/sdk/python-sdk) for the API surface.
</Callout>
```

## Cross-linking

Link, do not duplicate. When another page covers the topic, link it. These shapes are in use:

```mdx
see [Multimodal](/sdk/ai-capabilities/multimodal)
see [Sharded models](/sdk/models/sharded-models)
see [Concurrent completions](#concurrent-completions)              {/* same-page anchor */}
[`deleteCache({ kvCacheKey })`](/sdk/reference/api/deleteCache)     {/* symbol -> reference page */}
[a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml)
```

Write a symbol reference in prose as inline code, linked to its reference page.
