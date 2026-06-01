---
name: qv-qip-significance-check
description: Conservatively checks whether a planned change, implementation, or PR review touches architectural significance triggers such as public SDK API, native dependency, plugin contract, model registry contract, runtime, transport, storage, release flow, npm publishing, deployment schema, security enforcement, NFR, or architecture principles. Recommends drafting a QIP before going deeper when impact is clear. Use during planning, implementation, PR review, or when invoking /qv-qip-significance-check.
---

# QIP Significance Check

Conservatively decide whether a change needs a QIP before deeper implementation or merge recommendation.

## When to use this skill

**Use when:**

- Planning or implementing a change that may affect architecture
- Reviewing a PR or diff for cross-package, contract, delivery, or principle impact
- Another workflow asks whether a proposal is needed first
- User invokes `/qv-qip-significance-check`

**Do NOT use for:**

- Drafting the QIP itself (use `qv-qip-create`)
- Reviewing an existing QIP draft (use `qv-qip-review`)

## Core stance

- Bias toward not interrupting the team
- Better to miss borderline proposal candidates than to ask for a QIP on every small PR
- This is advisory only. Never block mechanically or claim work cannot proceed

## Workflow

1. Read [references/significance-triggers.md](references/significance-triggers.md)
2. Inspect the requested change, planned work, or diff
3. Apply the checklist with a high-confidence bar only
4. If no trigger clearly fires, say so briefly and continue normally
5. If a trigger clearly fires:
   - Name the trigger and why in one or two sentences
   - Recommend drafting a QIP before going deeper
   - Ask whether to hand off to `qv-qip-create`
   - Do not start drafting unless the user confirms

## Output format

**When no trigger fires:**

```text
No architectural significance trigger clearly applies. Proceed with normal team review.
```

**When a trigger fires:**

```text
Trigger: <trigger name>
Why: <one or two sentences>

This looks architecturally significant because it changes <trigger>. I recommend drafting a short QIP before we go deeper, so the affected people can review the direction early. Want me to start a QIP draft from what we know?
```

## Efficiency rules

- Read the trigger reference once per session
- Do not re-run the full checklist on every tiny follow-up edit unless scope changed materially
- Cap shell calls at 0-2 unless inspecting a PR diff requires `gh pr diff`

## Additional resources

- Trigger reference: [references/significance-triggers.md](references/significance-triggers.md)
