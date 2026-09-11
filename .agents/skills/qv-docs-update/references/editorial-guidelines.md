# Editorial guidelines

Every rule below is a pattern the current pages already follow. Obey them and the patch reads like the page it lands in.

Where the corpus is inconsistent, this file says so. Match the page you are editing. Never normalise a neighbour.

Primary exemplars: `ai-capabilities/text-generation.mdx` is the richest page, `ai-capabilities/image-classification.mdx` the minimal canonical one.

## Language and terminology

- Write in English only.
- Call the reader a **user**, never a "consumer". In an SDK context, "consumer" means other software. Use `user`, `users`, `user-facing`. This applies to the skill's own reports too.
- Address the user in the second person ("you control the session identity") or use the bare imperative ("Load any supported model"). Both are current.
- Use the present tense for behaviour. Describe what the code does, not what it will do.
- Write headings in sentence case: `## Text generation`, `### Concurrent completions`. Product and command names keep their own casing: `` ### `qvac serve` ``, `## HTTP server`, `## RAG`.

`text-generation.mdx` contains one violation: "so consumers don't have to parse tags from raw text". Do not copy it. Do not fix it either. A drive-by terminology correction is an editorial edit unrelated to the source change, and the Phase 6 diff review rejects it.

## Page structure — `ai-capabilities/`

All 18 capability pages share this skeleton:

```text
frontmatter:  title, description, schemaType: HowTo
## Overview
## Functions
## Models              (17/18 — rag.mdx has "## Pipeline" instead)
## Example | ## Examples
<Callout type="success"> footer tip   (17/18)
```

Use `## Example` for exactly one example. Use `## Examples` with one `###` subsection per example when there are several. Never wrap a single example in `## Examples`.

Place optional sections between `## Models` and `## Example(s)`, and only with evidence in the source. The ones observed are `## Features`, `## Enable the plugin`, `## Audio output`, `## Training`, `## Pipeline`, and `## Cancellation`. When in doubt, omit: a missing optional section is invisible, an invented one is wrong.

Frontmatter `title` capitalization is not normalized across the corpus (`Text generation`, `Text-to-Speech`). Follow the capability's own name.

Only capability pages get `schemaType: HowTo`. `cli/index.mdx` uses `schemaType: TechArticle` and adds `ogImage`.

### `## Overview`

Open by naming the inference engine and linking its package. Then state the `modelType`. Then state the input and output shapes.

> Text generation uses [`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp) as inference engine. Load any supported model using `modelType: "llm"`.

> Image classification uses a **GGML** inference engine ([`@qvac/classification-ggml`](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml)). Load a model using `modelType: "classification"`.

### `## Functions`

Write an ordered list of the call sequence. Link each item to its API summary anchor. Close with the fixed line.

```mdx
Use the following sequence of function calls:
1. [`loadModel()`](/reference/api#loadmodel)
2. [`completion()`](/reference/api#completion)
3. [`unloadModel()`](/reference/api#unloadmodel)

For how to use each function, see [SDK — API reference](/reference/api/).
```

Copy the closing line verbatim. It is boilerplate.

This shape belongs to capability pages only. Pages outside `ai-capabilities/` have their own, and imposing this one on them is a rewrite, not a patch. `runtime/logging.mdx` uses a numbered list with no preamble and items that describe roles. `runtime/cancellation.mdx` groups APIs by mechanism, so its list is not a call order. `ai-capabilities/world-simulation.mdx` adds a `###` subsection per function underneath `## Functions`.

Some pages annotate an item with a trailing em-dash note:

```mdx
1. [`loadModel()`](/reference/api#loadmodel) — load with `modelConfig.parallel >= 2`.
```

Build the anchor by lowercasing the symbol name and stripping the parentheses: `assessModelFit()` becomes `/reference/api#assessmodelfit`.

Take the symbol from `packages/sdk/src/client/api/index.ts`, not from the filename. The barrel is the authority, and `completion-stream.ts` exports `completion`.

**Always link a symbol to its API anchor when one exists.** The anchor is R2's primary binding, so this rule keeps the next run's routing working. Two shapes in the corpus break it:

```mdx
[`getLogger()`](/reference/api)                                  {/* no anchor */}
[`batchCompletion()`](/ai-capabilities/batch-processing)          {/* points at a page, not the anchor */}
```

R2 has a secondary pass that catches a symbol linked somewhere other than its anchor, so neither is invisible. The hit is reported as the weaker binding. A symbol mentioned in prose with no link at all is routed by nothing.

### `## Models`

Write either prose plus a `-` bullet list of cross-references, or a `-` list of families and their file layouts. Both are current.

> You can load any [`llama.cpp`](https://github.com/ggml-org/llama.cpp)-compatible text-generation/chat model. Model file format: `*.gguf`.

> Supported model families and their file layouts:
>
> - **MobileNetV3-Small**: single all-in-one `*.gguf` file — the base model or any fine-tune of the same architecture (converted to GGUF).

Nearly every page closes the section with a pointer to the model constants. Every variant ends with the same link:

```
[SDK — Models](/introduction#models)
```

The lead-in has four variants and they are not interchangeable. Match the page you are editing.

| Occurrences | Lead-in |
| --- | --- |
| 12 | `For models available as constants, see …` |
| 2 | `For model artifacts available as constants, see …` |
| 1 | `For model constants, see …` |
| 1 | the 12-variant plus a trailing caveat about quantization |

Placement varies too: a standalone paragraph on some pages, the last bullet of a list on others, inside a `###` subsection on `transcription.mdx`. Rewriting one variant into another is an unrelated editorial edit, and the Phase 6 diff review rejects it.

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
- Use the right path per language. The difference is not cosmetic:
  - `js` → `packages/sdk/dist/examples/<name>.js`, the build output of the `.ts`
  - `ts` → `packages/sdk/examples/<name>.ts`
  - `python` → `packages/sdk-python/examples/<name>.py`
- Leave the fence body empty. The MDX pipeline injects the file contents.
- Keep `lineNumbers` on every file-referenced block.
- Treat `title=` as editorial. It need not match the filename: `text-generation.mdx` references `tools/llamacpp-native-tools.ts` with `title="completion-tool-call.ts"`. When adding a tab to an existing `<Tabs>`, keep the title consistent with the sibling tabs.

`<Tabs>` is the pattern for runnable scripts, not a universal wrapper. `configuration/index.mdx` shows its schema with `<WrapCode>` and a single JSON fence, because there is one language and nothing to switch between.

Inline snippets are permitted where a whole runnable file would be noise. Observed uses: a call-shape illustration, a `loadModel({…})` recipe inside `## Models`, an event-loop pattern, a shell one-liner in `cli/index.mdx`, and a sample of log output in a bare fence. The `kvCache` block is the model to follow:

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

> The following script classifies a JPEG image using the bundled MobileNetV3-Small model:

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
**Tip:** all examples throughout this documentation are self-contained and runnable. For instructions on how to run them, see the [JS/TS quickstart](/js-ts-sdk#quickstart) or the [Python quickstart](/python-sdk#quickstart).
</Callout>
```

If a capability has no Python example, then declare it with this callout, verbatim, instead of staying silent.

```mdx
<Callout type="info">
The Python client supports this capability through the same worker. A dedicated Python example is not yet published — see the [Python SDK](/python-sdk) for the API surface.
</Callout>
```

## Cross-linking

Link, do not duplicate. When another page covers the topic, link it. These shapes are in use:

```mdx
see [Multimodal](/ai-capabilities/multimodal)
see [Sharded models](/models/sharded-models)
see [Concurrent completions](#concurrent-completions)          {/* same-page anchor */}
[`deleteCache({ kvCacheKey })`](/reference/api#deletecache)     {/* symbol -> API summary */}
[a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml)
```

Write a symbol reference in prose as inline code, linked to its API summary anchor. R2 routes on that link.

## Writing the patch

1. Write the smallest change that settles the target's `Reason`, then stop.

If the new text asserts something the `Reason` does not support, it is scope creep or hallucination. Write it again.

2. Correct a stale claim in place. Never rewrite a section to fix a sentence.

3. Preserve everything else byte for byte, including the corpus's existing inconsistencies: trailing spaces, `*` versus `-` markers, punctuation. A normalising diff buries the real change.

4. Ground every claim in the source: TSDoc, the example file, a test, the model registry. If a claim cannot be grounded, then emit `HUMAN_INPUT_REQUIRED`. Never guess.
