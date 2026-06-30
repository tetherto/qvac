# lgci certify E — verified + desktop + mobile (trigger then cancel)

Scenario E: `verified` + `run-desktop-addon-tests` + `run-mobile-addon-tests` →
desktop + mobile (+ prebuilds) must trigger. Capture skipped->queued, then close
immediately to cancel before Device Farm completes. Throwaway.
