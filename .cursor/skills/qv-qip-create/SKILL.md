---
name: qv-qip-create
description: Use when drafting a QIP, after qv-qip-triage recommends creating one, shaping a fuzzy technical proposal with alternatives and consequences, or invoking /qv-qip-create.
disable-model-invocation: true
---

# QIP Proposal Create

Help an author draft a QIP before posting to Slack Canvas.

Core principle: a QIP draft is earned by evidence, decision context, and explicit trade-offs. Do not treat this as a template-filling or content-generation task.

## When to use this skill

**Use when:**

- The user wants to create a QIP
- `qv-qip-triage` recommended a QIP and the user confirmed
- The user has a fuzzy idea and needs help shaping it
- User invokes `/qv-qip-create`

**Do NOT use for:**

- Deciding whether a QIP is needed (use `qv-qip-triage`)
- Reviewing an existing QIP for approval readiness (use `qv-qip-review`)

## Prerequisites

Read before drafting:

- [references/qip-template.md](references/qip-template.md)
- `docs/architecture/PRINCIPLES.md` for lightweight principle checks

## Question-first default

For every new QIP request, ask at least one clarifying question before drafting unless the user explicitly says:

- `draft with assumptions`
- `make a first pass`
- `no questions`
- `use my brief as final context`

A terse slash-command prompt with only a title, technology list, package name, or desired outcome is fuzzy idea mode. Examples:

- `/qv-qip-create Kotlin SDK Android Coroutines JNI Maven Central`
- `/qv-qip-create native mobile SDK`
- `/qv-qip-create improve registry replication`

If the prompt names several possible motivations, ask the user to choose the primary driver instead of guessing.

## Entry modes

### Clear proposal mode

Use only when the user already provided:

- Problem: what is broken, missing, risky, or strategically needed
- Timing: why this needs attention now
- Chosen direction: what decision is being proposed
- Affected surface: packages, products, teams, users, public APIs, runtime boundaries, or release flows
- Trade-offs: at least one cost, rejected option, or consequence reviewers must accept

Do not classify a request as clear proposal mode just because it contains many solution details. A rich technology list is still fuzzy idea mode if the problem, timing, affected surface, and trade-offs are not explicit.

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

## Draft readiness gate

Before saving or presenting a QIP draft, confirm these are known:

- Problem and timing
- Affected surface
- Existing option or current behavior
- Chosen direction
- At least one credible alternative
- Trade-offs and new responsibilities
- Trust boundary impact, if any
- Compatibility, migration, and release impact, if any

If two or more are unknown, do not draft. Ask the next most important question. If exactly one is unknown, either ask or label it clearly as an assumption.

## Evidence and assumption rules

Do not invent:

- production motivations
- team commitments
- implementation strategy
- supported platforms or ABIs
- release plans
- security properties
- performance claims
- ownership decisions

Every substantive claim in the QIP must come from one of:

- user-provided context
- existing repo documentation
- existing code
- a clearly labeled assumption

Prefer questions over assumptions for architectural proposals. If the draft includes assumptions, keep them explicit and easy for the author to confirm or delete.

## Architecture-change verification

If the proposal affects SDK API, native bindings, runtime, mobile support, storage, transport, model registry, release flow, or security boundaries, inspect relevant repo docs or code before drafting.

Minimum verification:

- Read current architecture principles
- Search for existing implementation or docs in the affected area
- Identify current behavior and the proposed delta
- State unknowns explicitly

Do not produce a full QIP from general knowledge alone.

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

- For non-trivial QIPs or expected iteration, save the draft as a markdown file before presenting it. Use a user-provided path when available; otherwise ask where to save it. `arch/qips/<short-slug>.md` is only an example local path, not a required repo path.
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
- Keep drafts concise. If the available context only supports a problem-framing note, write that instead of padding a full QIP.

## Proposal substance checks

Before finalizing, check whether the proposal needs any of these:

- Trust boundary: if the proposal changes transport, RPC, storage, auth, sandboxing, plugin execution, model provenance, or any cross-process / cross-peer boundary, state the security properties explicitly. If properties are unchanged, say so briefly.
- Solution rationale: explain why the chosen approach is needed, not just what it changes. If another obvious option could solve the same problem, name why the proposal prefers this one.
- Compatibility / release impact: call out observable behavior changes, public API changes, dependency/install-contract changes, migration needs, and expected versioning impact when relevant. If there is no breaking change, say so briefly.

If the rationale or impact is unclear, investigate the existing code/docs enough to form a grounded draft or ask the user for the missing decision context.

## Red flags - stop and ask

Stop drafting and ask a question when you notice any of these:

- You are choosing the primary motivation yourself
- You are describing implementation details the user did not provide and the repo does not verify
- You are writing benefits without corresponding trade-offs
- You are naming affected teams, platforms, security properties, or release plans from inference alone
- The draft reads like generic SDK marketing copy instead of a decision artifact
- You cannot explain what reviewers are being asked to approve

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
