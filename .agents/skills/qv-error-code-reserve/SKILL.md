---
name: qv-error-code-reserve
description: Use when reserving numeric QVAC error code ranges for a new package or external product, expanding an allocation, or checking which ranges are occupied.
---

# Reserve QVAC error codes

Use `packages/error/code-ranges.json` in `tetherto/qvac`, following the
[allocation rules](../../../packages/error/README.md#error-code-conventions).
Read the [validator details](../../../packages/error/docs/code-ranges.md) when
editing registry fields or adding external test integration.

## Select and prepare a reservation

1. Establish the package's manifest name and repository. For a request to list
   available blocks, inspect and report without editing.
2. Check the latest registry on `main` and pending reservation PRs. A pending PR
   is a proposed claim; the merged registry is authoritative.
3. Select an unoccupied block under the allocation rules. Preserve unused and
   retired reservations; prefer new space over historical gaps. Add the owner
   and bounds to `allocations`, ordered by their lowest number.
4. For monorepo adoption, list the actual numeric maps in `sources`. For external
   adoption, follow the documented test integration using the reviewed registry;
   the reservation must merge here before use in the external repository.
5. Run the documented validation commands and the affected package's checks.
   Recheck after updating from `main` to catch concurrent claims.

Keep published numbers stable. Do not add compatibility exceptions merely to
make validation pass. Report the chosen block, owner, checks, and any external
adoption still needed. Prepare local changes; commits, pushes, PRs, and edits to
external repositories require the user's authorization.
