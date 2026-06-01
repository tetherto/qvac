---
name: qv-qip-create
description: Use when drafting a QIP, responding to qv-qip-significance-check, shaping a fuzzy architecture proposal, or invoking /qv-qip-create.
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

- For non-trivial QIPs or expected iteration, save the draft as a markdown file before presenting it. Prefer `arch/qips/<short-slug>.md` when working in this repo.
- Keep the saved file Canvas-ready with only the consultation note, template sections, and author checklist
- Keep wording concrete and short
- Do a cleanup pass before finalizing: remove non-important details, obvious statements, duplicate or near-duplicate points, and stale context
- Prefer precise domain terms over long explanations when they are clearer, e.g. `idle timeout`, `whole-stream deadline`, `idempotent`, `terminal failure`
- Write Solution as an explanation of how the problem is solved. Do not make it just a task list; use bullets only for compact scope boundaries after the reader understands the design.
- Treat the template's Risks section as consequences and trade-offs for proposal review. Avoid a probable-production-bugs list; state what reviewers must accept, then add mitigation only where it affects whether the proposal should be accepted, changed, or split.
- Remove "risks" that the proposed design already rules out; keep consequences that remain true after the design is implemented.
- Fold alternatives and consequences into Solution and Risks when helpful
- Add a diagram only when runtime, package, or approval boundaries are non-obvious
- Do not invent approvals, commitments, or team decisions
- Do not claim the QIP is approved

## Output format

For file-based drafts, reply with the saved path and a brief summary of what changed. Do not paste the whole QIP unless the user asks.

For chat-only drafts, first show `People to consult before posting`, then the draft:

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
