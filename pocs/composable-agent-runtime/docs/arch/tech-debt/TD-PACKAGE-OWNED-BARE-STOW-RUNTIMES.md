# TD: Package-Owned Bare-Stow Runtimes

## Problem

Assistant currently builds the Sync, Harness, and SDK PoC bundles and passes
bundle entry paths into `spawnSync()` and `spawnHarness()`. Direct package
consumers must therefore understand `bare-stow`, locate an entry, and reproduce
Assistant's bundle assembly. Assistant also performs compatibility checks that
belong with each package's generated client and worker.

## Recommended Solution

Make each worker-owning package distribute and start its own matching
`bare-stow` runtime behind a public client factory. Sync owns Sync packaging,
Harness owns Harness packaging, and SDK owns the Inference runtime based on
`@qvac/inference`. Move worker identity, protocol, and capability validation
into those clients. Assistant should compose ready public clients without
building bundles or receiving worker entry paths.

