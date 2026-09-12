# Docs impact policy — what counts as user-facing

Phase 3 classifies a `SOURCE_CHANGE_SET` against this file to produce a `DOCS_IMPACT`.

The question is not "did the code change?". Phase 1 already answered that. There are two questions, and a bad answer to either one means the change has impact.

1. Did a claim the documentation makes stop being true, or become materially incomplete?
2. With the docs exactly as they stand today, can a user use the feature that changed?

Question 1 catches a page that went stale. Question 2 catches a page that is still correct and yet leaves the user unable to reach the new capability. The tables below mostly answer question 1. Keep question 2 in mind for every row: a change can pass the tables and still fail it.

Terminology: the reader of these docs is a **user**. Reserve "consumer" for software that consumes the SDK. This applies to the skill's own reports, not only to generated prose.

## Counts as impact

| Change | Why |
| --- | --- |
| New exported function, or a removed or renamed one | The public surface changed. |
| Signature change on an exported function | Call sites documented on a page may no longer be valid. |
| New parameter needed to use a feature | See "Parameters" below. This is the most common misclassification. |
| Observable behaviour change: defaults, ordering, limits, error conditions, emitted events | Pages state these in prose. A stale statement is worse than a missing one. |
| New or changed model family, model type, or `modelSrc` layout | `## Models` sections enumerate these. |
| New or changed configuration key, or its accepted values or default | `configuration/index.mdx` documents keys in a table, so an omission shows as an incomplete enumeration. |
| New, changed, or deleted example file | Pages reference examples by literal path and introduce them with a sentence describing what the script does. |
| New CLI command, subcommand, or flag, or a change to visible output | Each command has its own heading in `cli/index.mdx`. |
| A deprecation | Users need to know before removal, not at removal. |

## Does not count as impact

- Internal refactors with an unchanged observable contract.
- Symbols marked `@internal`, or not re-exported from a barrel.
- Test-only changes. A test is evidence for Phase 3, never a target.
- Dependency bumps, lockfiles, CI config, `project.json`, version fields.
- Formatting, comments, and typo fixes in source that no page quotes.
- CLI infrastructure: option parsing, logger internals, error plumbing.

If a CLI infrastructure change alters visible output, then it counts. This policy catches that case, not the bucket.

## Fixes count on the same terms as features

A change labelled `fix` counts as impact whenever it alters documented observable behaviour.

The feature/fix distinction is about intent and does not predict documentary impact. A fix that makes a function finally behave as documented needs no docs change. A fix that changes a default needs one. Judge the behaviour, not the prefix.

## Parameters — the case to get right

A new parameter is rarely `GENERATED_DOCS_ONLY`. The generated API summary says so about itself, verbatim:

```text
> **Fields shown**: description, signature, throws, examples, deprecation, prototype.
> **Fields intentionally omitted**: parameter descriptions, return field descriptions
> (covered by IDE hover and `.d.ts` declarations).
>
> This page is intentionally a high-level index.
```

So the summary shows that the parameter exists, in the signature. It never says what the parameter means or when to reach for it.

If a user cannot use the feature without knowing the parameter, then it belongs on the capability page. That is the pattern `ai-capabilities/text-generation.mdx` already follows for its generation controls. If the parameter is a tuning knob whose name and type say everything, then the summary is enough.

## `GENERATED_DOCS_ONLY` — narrow by design

Reserve it for three cases:

- a change the API summary expresses in full, given the field list above;
- a new symbol whose use needs no prose at all, which is rare;
- refactored internal types with no effect on the observable contract.

Revisit this section when the full deterministic API reference ships. The narrowness above follows from the summary being a high-level index today. Once per-parameter detail is generated, cases that are `DOCS_UPDATE_REQUIRED` now become legitimately `GENERATED_DOCS_ONLY`, and this policy will over-report.

## Deciding the state

Work down this list and stop at the first match.

1. If nothing changed in the three observed packages, then `NO_SOURCE_CHANGE`.
2. If something changed but nothing above counts, then `NO_DOCS_IMPACT`.
3. If it counts and the generated surfaces carry all of it, then `GENERATED_DOCS_ONLY`. Name the surface in the report.
4. If it counts and editable prose is now wrong or incomplete, then `DOCS_UPDATE_REQUIRED`. Proceed to routing.
5. If it counts and a new exported function institutes a capability with no page, then `NEW_CAPABILITY_PAGE`.
6. If it counts and no router resolves a destination, then `HUMAN_INPUT_REQUIRED` for that source only.

State 1 covers the whole run. Judge states 2 to 6 per source file, never for the whole run. One unresolved path does not discard the work already done on resolved pages.
