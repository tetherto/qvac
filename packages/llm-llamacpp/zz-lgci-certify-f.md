# lgci certify F — prebuild caching

Scenario F (run 1): `verified` + `prebuilds` → prebuild builds + cache-save
writes the per-PR cache. Then a JS-only push (run 2) must restore the cache
(prebuild SKIPPED), and a native push (run 3) must rebuild. Throwaway.
