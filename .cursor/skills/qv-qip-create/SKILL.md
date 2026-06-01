---
name: qv-qip-create
description: Guides creation of a Slack Canvas-ready QIP from a clear proposal or a fuzzy idea, including alternatives, consequences, risks, and people to consult before posting. Uses the QIP template and architecture principles as lightweight checks. Use when drafting a QIP, responding to a significance-check recommendation, or invoking /qv-qip-create.
---

# QIP Proposal Create

Help an author draft a QIP before posting to Slack Canvas.

## When to use this skill

**Use when:**

- The user wants to create a QIP
- `qv-qip-significance-check` recommended a QIP and the user confirmed
- The user has a fuzzy idea and needs help shaping it
- User invokes `/qv-qip-create`

**Do NOT use for:**

- Deciding whether a QIP is needed (use `qv-qip-significance-check`)
- Reviewing an existing QIP for approval readiness (use `qv-qip-review`)

## Prerequisites

Read before drafting:

- [references/qip-template.md](references/qip-template.md)
- `docs/architecture/PRINCIPLES.md` for lightweight principle checks

## Entry modes

### Clear proposal mode

Use when the user already has problem, solution, affected area or team, and known risks.

Ask only for missing essentials.

### Fuzzy idea mode

Use when the user has a problem or direction but no settled solution.

Ask short questions one at a time until enough context exists:

1. What problem are we solving and why now?
2. Which packages, products, teams, users, or operational workflows are meaningfully affected?
3. What is the existing option?
4. What are one or two alternative approaches?
5. What gets better, what gets worse, and what new failure modes appear?
6. What is explicitly out of scope for the first proposal?

Do not dump all questions at once unless the user asks for a batch.

## Consultation note

Before the final draft, produce a short `People to consult before posting` note.

Use this advice rule: consult everyone meaningfully affected and people with relevant expertise.

Include:

- Owning team lead for the affected package or product area
- Lead / Architect for technical validation
- Cross-cutting expert when the proposal touches runtime, transport, storage, security, model registry, native builds, or public SDK API
- Head of QVAC and CTO remain final approvers from the template, not early drafting bottlenecks unless the proposal is obviously strategic

Advice is direction plus reasoning, not a vote.

## Drafting rules

- Output a Canvas-ready draft with only the template sections
- Keep wording concrete and short
- Fold alternatives and consequences into Solution and Risks when helpful
- Add a diagram only when runtime, package, or approval boundaries are non-obvious
- Do not invent approvals, commitments, or team decisions
- Do not claim the QIP is approved

## Output format

First show `People to consult before posting`, then the draft:

```markdown
People to consult before posting
- <role or team>: <why>

QIP Template
:clipboard: Approvers
...
```

End with this author checklist:

```markdown
Author checklist
- [ ] Problem is clear and timely
- [ ] Solution is concrete enough to review
- [ ] Risks include mitigations
- [ ] Out of scope is explicit
- [ ] Approvers table preserved
- [ ] Consultation note reflects affected teams and expertise
```

## Handoff

If the user asks whether the draft is ready to post, suggest `qv-qip-review`.
