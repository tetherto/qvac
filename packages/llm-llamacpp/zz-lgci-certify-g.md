# lgci certify G — prebuild caching (clean)

Controlled single-prebuild run to avoid the concurrent cache-save collision
seen on PR F. Run 1 (verified+prebuilds) builds + saves cache cleanly; run 2
(JS-only) must restore (prebuild SKIPPED); run 3 (native) rebuilds.
