# Device Farm cost report

Weekly baseline + tracking for AWS Device Farm spend (QVAC-21758).

Device Farm is billed on **metered device-minutes**. This tool pulls the
metered minutes per project straight from the Device Farm API, attributes an
estimated cost at the AWS metered rate, and prints a week-over-week Markdown
breakdown so we can see whether the CI cost optimisations are actually moving
the number — and where the residual spend is.

## What it does

- Enumerates every Device Farm project in the account (`us-west-2`).
- Lists runs per project, newest-first, stopping once it pages past the
  window start (so a weekly report only reads recent runs).
- Rolls up **metered device-minutes** per project and per UTC day.
- Estimates cost at `--rate` USD/device-minute (default `0.17`, AWS public rate).
- Compares the current window against the immediately-preceding one.

## Usage

```bash
# Last 7 days vs the previous 7 days (default)
node scripts/devicefarm-cost/report.js

# Custom window, no baseline, machine-readable output
node scripts/devicefarm-cost/report.js --since 2026-06-01 --until 2026-07-01 --no-compare --json cost.json

# Just the LLM + embed + OCR cluster
node scripts/devicefarm-cost/report.js --project llamacpp-llm --project embed --project ocr
```

Run `node scripts/devicefarm-cost/report.js --help` for the full flag list.

Exit codes: `0` success, `1` completed with partial data (one or more
projects could not be read — figures may undercount), `2` fatal error.

## Prerequisites

- **AWS CLI** on `PATH` with credentials for account `833707431398`.
- IAM permissions: `devicefarm:ListProjects` and `devicefarm:ListRuns`.

In CI these come from the GitHub OIDC role (`secrets.AWS_OIDC_ROLE_ARN`);
that role must be granted the two Device Farm read actions account-wide.

## CI

`.github/workflows/devicefarm-cost-report.yml` runs this every **Monday
08:00 UTC** (and on demand via `workflow_dispatch`), writes the report to the
run's Step Summary, and uploads the JSON rollup as an artifact
(90-day retention).

## Layout

| File | Responsibility |
|---|---|
| `aggregate.js` | Pure rollup + Markdown rendering (no I/O). |
| `fetch.js` | AWS Device Farm access via the `aws` CLI. |
| `report.js` | CLI: arg parsing, window math, wiring, output. |
| `__tests__/aggregate.test.js` | `node:test` unit tests (no network). |

## Tests

```bash
node --test scripts/devicefarm-cost/
```

## Methodology notes

- Only **metered** device-minutes are counted (the billable figure);
  unmetered/free-tier minutes are excluded from cost.
- Cost is an **estimate** at a flat per-minute rate; it reconciles closely
  with the AWS cost export but is not a substitute for the invoice.
- Days are bucketed in **UTC**.
