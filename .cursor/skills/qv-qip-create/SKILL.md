---
name: qv-qip-create
description: Use when drafting a QIP, after qv-qip-need-proposal recommends creating one, shaping a fuzzy technical proposal with alternatives and consequences, or invoking /qv-qip-create.
---

# QIP Proposal Create

Help an author draft a QIP before posting to Slack Canvas.

## When to use this skill

**Use when:**

- The user wants to create a QIP
- `qv-qip-need-proposal` recommended a QIP and the user confirmed
- The user has a fuzzy idea and needs help shaping it
- User invokes `/qv-qip-create`

**Do NOT use for:**

- Deciding whether a QIP is needed (use `qv-qip-need-proposal`)
- Reviewing an existing QIP for approval readiness (use `qv-qip-review`)

## Prerequisites

Read before drafting:

- [references/qip-template.md](references/qip-template.md)
- `docs/architecture/PRINCIPLES.md` for lightweight principle checks

## Entry modes

### Clear proposal mode

Use when the user already has problem, solution, affected area or team, and known consequences.

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
- Keep `Alternatives considered` separate from Solution. Include obvious options reviewers would expect to see, but keep each to 1-2 sentences or link to research for detailed analysis.
- Write `Consequences` as positive impact plus trade-offs for proposal review. Avoid a probable-production-bugs list; state what reviewers must accept, then add mitigation only where it affects whether the proposal should be accepted, changed, or split.
- Remove issues that the proposed design already rules out; keep consequences that remain true after the design is implemented.
- Add a diagram only when runtime, package, or approval boundaries are non-obvious
- Do not invent approvals, commitments, or team decisions
- Do not claim the QIP is approved

## Proposal substance checks

Before finalizing, check whether the proposal needs any of these:

- Trust boundary: if the proposal changes transport, RPC, storage, auth, sandboxing, plugin execution, model provenance, or any cross-process / cross-peer boundary, state the security properties explicitly. If properties are unchanged, say so briefly.
- Solution rationale: explain why the chosen approach is needed, not just what it changes. If another obvious option could solve the same problem, name why the proposal prefers this one.
- Compatibility / release impact: call out observable behavior changes, public API changes, dependency/install-contract changes, migration needs, and expected versioning impact when relevant. If there is no breaking change, say so briefly.

If the rationale or impact is unclear, investigate the existing code/docs enough to form a grounded draft or ask the user for the missing decision context.

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
- [ ] Chosen solution is justified against obvious alternatives
- [ ] Trust boundaries and security properties are explicit when affected
- [ ] Compatibility, migration, and release impact are explicit when affected
- [ ] Alternatives considered is brief or links to detailed research
- [ ] Consequences state positive impact and trade-offs reviewers must accept
- [ ] Out of scope is explicit
- [ ] Approvers table preserved
- [ ] Consultation note reflects affected teams and expertise
```

## Handoff

If the user asks whether the draft is ready to post, suggest `qv-qip-review`.
