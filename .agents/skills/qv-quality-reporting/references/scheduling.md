# Twice-Monthly Quality Reporting

Use the Codex automation capability only when the user asks to schedule,
reschedule, pause, or remove recurring quality reporting.

The default is a thread heartbeat on the 1st and 15th of each month at 10:00 in
the user's local timezone. Preserve a different time or cadence when the user
specifies one.

Use this automation prompt:

> Run `$qv-quality-reporting` for the current repository. Compare the current
> deterministic audit and triage with existing marked Asana work. Stay quiet
> when all groups are unchanged. Notify me only about new actionable groups,
> material regressions, apparent resolutions that need review, incomplete
> analysis, ambiguous matches, or another decision I must make. Never create,
> update, or complete an Asana task without approval in the thread.

The scheduled run may prepare `.quality/proposals.json`, but it must stop at the
same numbered approval review as an interactive run. Do not put notification
preferences into the replayed prompt when the automation interface has a
dedicated notification policy.
