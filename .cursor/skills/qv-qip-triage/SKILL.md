---
name: qv-qip-triage
description: Use during planning, implementation, PR review, or /qv-qip-triage when a change may affect public SDK API, native dependency, plugin contract, model registry contract, runtime, transport, storage, release flow, deployment, security, NFR, or technical principles.
---

# QIP Triage

Conservatively decide whether a change needs a QIP before deeper implementation or merge recommendation.

## When to use this skill

**Use when:**

- Planning or implementing a change that may affect technical direction
- Reviewing a PR or diff for cross-package, contract, delivery, or principle impact
- Another workflow asks whether a proposal is needed first
- User invokes `/qv-qip-triage`

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
   - List the exact points that need a QIP, not the whole requested change
   - Separate implementation details that do not need a QIP on their own
   - Recommend how many QIPs are needed:
     - One QIP when the points are one decision with a shared consequence set
     - Multiple QIPs when points can be approved, rejected, or shipped independently
   - Name each proposed QIP scope in plain language
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

QIP-worthy points:
- <exact point that needs proposal review>

Not QIP-worthy on its own:
- <implementation detail or ordinary work>

Proposal count:
<One QIP: <scope name> / Multiple QIPs: <scope names and why split>>

This looks technically significant because it changes <trigger>. I recommend drafting the proposal(s) above before going deeper, so the affected people can review the direction early. Want me to start a QIP draft from what we know?
```

## Efficiency rules

- Read the trigger reference once per session
- Do not re-run the full checklist on every tiny follow-up edit unless scope changed materially
- Cap shell calls at 0-2 unless inspecting a PR diff requires `gh pr diff`

## Additional resources

- Trigger reference: [references/significance-triggers.md](references/significance-triggers.md)
