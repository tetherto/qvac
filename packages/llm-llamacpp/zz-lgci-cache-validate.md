# lgci cache validation (post-merge, real workflow)

Throwaway PR to confirm the merged prebuild artifact caching (#2969) actually
reuses on `main` under pull_request_target. Run 1 (verified+prebuilds) builds
+ saves the marker; run 2 (JS-only push) must reuse -> prebuild SKIPPED.
Delete after.

run 2 (JS-only) — expect reuse hit + prebuild skipped
