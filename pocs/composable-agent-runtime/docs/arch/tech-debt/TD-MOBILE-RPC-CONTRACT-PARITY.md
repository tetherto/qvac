# TD: Mobile RPC Contract Parity

## Problem

The mobile feasibility host uses a custom newline-delimited JSON protocol for
runtime lifecycle probes, while desktop Sync and Harness use generated HRPC
contracts over `bare-stow` sidecars. The mobile path therefore does not prove
that the same public clients, capability checks, and wire behavior work across
desktop processes and BareKit or native mobile boundaries.

## Recommended Solution

Run the package-owned generated contract over platform-specific transports:
`bare-stow` sidecars on desktop and BareKit or native process adapters on
mobile. Keep worker startup platform-specific, but share request schemas,
capability semantics, error envelopes, and conformance fixtures across all
hosts. Remove the probe protocol after the production mobile adapters cover the
same lifecycle tests.

