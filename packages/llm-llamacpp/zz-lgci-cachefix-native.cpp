// Throwaway unique native file for caching-FIX e2e test (QVAC-21199 follow-up).
// Gives this PR a unique native_hash so its reuse marker is distinct. Run 1
// builds + saves the marker; run 2 (JS-only push) must REUSE this run's
// prebuilds artifact (prebuild skipped). Not compiled; delete with the branch.
int lgci_cachefix_probe_5d2e() { return 0; }
