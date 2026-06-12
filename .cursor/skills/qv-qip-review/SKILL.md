---
name: qv-qip-review
description: Reviews a QIP draft or Slack Canvas proposal for approval readiness, missing alternatives, unclear consequences, architecture principle conflicts, and consultation coverage. Produces blockers, clarifying questions, suggested edits, and optional Slack-ready review comments. Use when reviewing a QIP or invoking /qv-qip-review.
---

# QIP Proposal Review

Review a QIP for approval readiness without substituting for human approvers.

## When to use this skill

**Use when:**

- Reviewing a QIP draft before posting to Slack Canvas
- Reviewing a QIP as Lead / Architect, Head of QVAC, or CTO support
- The author asks whether the proposal is ready
- User invokes `/qv-qip-review`

**Do NOT use for:**

- Creating the first draft (use `qv-qip-create`)
- Deciding whether a QIP is needed at all (use `qv-qip-triage`)

## Inputs

Accept any of:

- Pasted Slack Canvas text
- Local markdown draft
- Summarized proposal from chat

## Review workflow

1. Read [../qv-qip-create/references/qip-template.md](../qv-qip-create/references/qip-template.md)
2. Read `docs/architecture/PRINCIPLES.md` before checking for principle conflicts
3. Apply the review criteria below
4. Check system fit against `docs/architecture/ARCHITECTURE.md` when the proposal touches runtime, package, plugin, registry, or deployment boundaries
5. Separate blockers from clarifying questions and nice-to-have improvements
6. Never claim approval on behalf of named approvers

## Review criteria

**Template completeness**

- Problem explains what and why
- Solution is concrete enough to evaluate
- Alternatives considered is concise or links to detailed research
- Consequences state positive impact and trade-offs reviewers must accept
- Out of scope is present when confusion is likely
- Approvers table is preserved

**Architecture**

- Flag principle conflicts explicitly by principle number and name
- Flag missing positive impact, trade-offs, or negative consequences
- Treat principle conflicts as review findings, not automatic rejection, unless the proposal hides the trade-off

**Consultation coverage**

- Owning team lead for affected area
- Lead / Architect for technical validation when contracts or cross-package impact are involved
- Cross-cutting expert when runtime, transport, storage, security, registry, native builds, or public SDK API are involved

Advice coverage is not a voting scheme.

## Output format

Lead with findings ordered by approval risk:

```markdown
## Blockers
- ...

## Clarifying questions
- ...

## Suggested edits
- ...

## Approval readiness
Ready | Ready with minor edits | Not ready

## Slack comment
<optional concise paste-ready comment if requested>
```

If there are no blockers, say so explicitly.

## Efficiency rules

- Do not rewrite the whole QIP unless the user asks
- Prefer targeted edits over generic process advice
- Keep the Slack comment under one screen when provided
