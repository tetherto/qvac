# Docs impact policy — what counts as user-facing

Phase 3 classifies a `SOURCE_CHANGE_SET` against this file to produce a `DOCS_IMPACT`.

The question is not "did the code change?". Phase 1 already answered that. There are two questions, and a bad answer to either means the change has impact.

1. Did a claim the documentation makes stop being true, or become materially incomplete?
2. With the documentation exactly as it stands, can a user use what changed?

Question 1 catches a page that went stale. Question 2 catches a page that is still correct and yet leaves the user unable to reach the new capability. Keep question 2 in mind for every row below.

Call the reader a **user**. Reserve "consumer" for software that consumes the SDK. This applies to the skill's own reports too.

## Counts as impact

| Change | Why |
| --- | --- |
| New public symbol, or a removed or renamed one | The public surface changed. Bindings and coverage name the pages. |
| Signature or field change on a public symbol | Call sites and explanations on a page may no longer hold. |
| New parameter needed to use a feature | See "Parameters" below. |
| Observable behaviour change: defaults, ordering, limits, error conditions, emitted events | Pages state these in prose, and no generated data carries them. |
| New or changed model family, model type, or model file layout | Pages explain which models a task takes; the model list itself is data. |
| New or changed configuration key, or its accepted values or default | Pages explain configuration; where a schema exists, its table is data. |
| New, changed, or deleted example file | Pages import examples by path and introduce each with a sentence on what it does. |
| New command, subcommand, flag, or HTTP operation, or a change to visible output | Options and operations are data; when and why to use them is prose. |
| A deprecation | Users need to know before removal, not at removal. |

## Does not count as impact

- Internal refactors with an unchanged observable contract. The bindings agree: an unchanged projected surface reports no drift.
- Symbols that are not public.
- Test-only changes. A test is evidence for Phase 3, never a target.
- Dependency bumps, lockfiles, CI config, version fields.
- Formatting, comments, and typo fixes in source that no page quotes.
- Option parsing, logger internals, error plumbing — unless they alter visible output.

## Fixes count on the same terms as features

A `fix` counts as impact whenever it alters documented observable behaviour. A fix that makes a function behave as documented needs no change. A fix that changes a default needs one. Judge the behaviour, not the prefix.

## Parameters — the case to get right

The reference pages, the schema tables, and the agent cards render every field of a request with its type, its constraints, and its description. A new parameter is therefore always visible, and its meaning is visible when the source describes it.

What data never says is when a user should reach for the parameter, or how it interacts with the rest of the feature. If a user cannot use the feature well without knowing that, the parameter belongs in the page's prose. If its name, type, and description say everything, the data is enough.

A field with no description in the source is a gap to report, not one to fill with prose: the description belongs in the source schema, where every channel reads it.

## `GENERATED_DOCS_ONLY`

Use it when regenerated data carries the whole change:

- a new or changed field whose description says all a user needs;
- a new model in a family a page already explains;
- a new option or HTTP operation that needs no explanation beyond its description;
- a change to types with no effect on the observable contract.

Name the data that carries it in the report: the reference page, the schema table, the models table, the command reference.

## Deciding the state

Work down this list and stop at the first match.

1. If nothing changed in any documented software, then `NO_SOURCE_CHANGE`.
2. If something changed but nothing above counts, then `NO_DOCS_IMPACT`.
3. If it counts and regenerated data carries all of it, then `GENERATED_DOCS_ONLY`.
4. If it counts and hand-written prose is now wrong or incomplete, then `DOCS_UPDATE_REQUIRED`.
5. If it counts and a new public symbol has no page covering its topic, then `NEW_PAGE`.
6. If it counts and no page can be found for it, then `HUMAN_INPUT_REQUIRED` for that file only.

State 1 covers the whole run. Judge states 2 to 6 per source file. One unresolved file never discards the work done on the others.
