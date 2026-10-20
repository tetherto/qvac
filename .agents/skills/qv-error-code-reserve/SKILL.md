---
name: qv-error-code-reserve
description: Use when reserving numeric QVAC error code ranges for a new package or external product, expanding an allocation, or checking which ranges are occupied.
---

# Reserve QVAC error codes

The authority is `packages/error/code-ranges.json` in `tetherto/qvac`.
Read the [allocation workflow](../../../packages/error/README.md#error-code-conventions)
before editing it. This registry covers external products as well as the monorepo.
For registry fields or external test integration, read the
[validator details](../../../packages/error/docs/code-ranges.md).

## Select and prepare a reservation

1. Establish the package's real manifest name and whether it lives in the monorepo
   or an external repository. If the request only asks which blocks are available,
   inspect and report without changing files.
2. Read the latest registry on `main`, using the local checkout only after checking
   that its allocation data is current. Consider pending reservation PRs too; a
   pending PR is a proposed claim, and a merged reservation is authoritative.
3. Keep all occupied blocks, including `reserved`, `retired`, and unused portions
   of active blocks. Before selecting a historical gap, check earlier allocation
   records and package history. Prefer a new block after the highest allocated
   number in the appropriate band. Monorepo packages stay below 100000; external
   products use 100000 and above. Normally reserve at least 1000 numbers.
4. Add the owner and inclusive bounds to `allocations`, keeping entries ordered by
   their lowest number. Use `reserved` before adoption or `active` when the first
   code ships in this change. An external product must merge the reservation here
   before using it in its own repository.
5. For monorepo adoption, add the actual numeric map's file, owner, and symbols to
   `sources`. Keep maps static so CI can read them without loading native addons.
   For external adoption, add a test in that repository calling
   `validatePackageCodes` against its actual code map and the reviewed registry.
6. Run `npm run errors:check`, `npm run errors:test`, and
   `npm run errors:typecheck` from the monorepo root. Run the affected package's
   normal checks when its source changes. Recheck reservations after updating
   from `main`, since concurrent PRs may claim the same block.

Do not renumber published codes, remove old reservations, or grant broad overlap
exceptions to make validation pass. A rename retains its allocation and records
the old owner in `formerOwners`. `sharedWith` and per-code `aliases` are only for
confirmed compatibility relationships. Keep historical conflict explanations next
to their allocations.

The README links to the registry; do not add a second allocation table or a README
generation script. Report the chosen block, owner, validation, and any external
repository adoption still needed. This skill does not authorize commits, pushes,
PR creation, or external repository edits beyond the user's requested scope.
