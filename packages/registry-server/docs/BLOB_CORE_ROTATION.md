# Model Blob-Core Rotation

Blob-core rotation directs future model ingests to a new Hyperblobs core. Existing
models keep their original `blobBinding` and remain readable from their recorded
core keys.

## Availability assumption

Rotation changes only the per-indexer blob core used for future model payloads. It
does not rotate the Autobase metadata view or change `QVAC_REGISTRY_CORE_KEY`.
Keep the registry available throughout the procedure by restarting one indexer at
a time and confirming its health before continuing.

`check:blob-cores` queries that stable metadata view through the normal registry
client. It is an inventory command, not a peer-availability check, so do not use an
empty result to diagnose registry connectivity. The procedure requires healthy
indexers before each inventory; if the registry health checks fail, stop the
rollout and restore metadata availability first. A test that removes every
metadata peer does not model this rotation procedure.

## Rotate the indexers

1. Record the current core inventory:

   ```bash
   npm run check:blob-cores -- --json
   ```

2. Pause model ingestion until every indexer has restarted. This prevents writes
   from landing in different generations during the rollout.

3. Choose a generation that has never been used before. For the planned
   2026-09-10 rollout, add this to `.env` on every indexer:

   ```bash
   QVAC_BLOB_CORE_GENERATION=2026-09-10
   ```

4. Reload one indexer at a time and wait for it to report healthy before moving to
   the next:

   ```bash
   pm2 reload registry --update-env
   curl -fsS http://127.0.0.1:9210/metrics | grep '^qvac_registry_is_indexer 1$'
   pm2 logs registry --lines 50 --nostream | grep 'active blob core ready'
   ```

   The startup log should report the label `models-2026-09-10` and its core key.

5. Resume ingestion and add a canary model through the normal model-ingestion
   workflow.

6. Run the inventory again. Confirm that it contains a new core key, then download
   one model from before the rotation and the canary model through the normal
   registry client.

Do not remove old Corestore data. Rotation limits future growth; it does not
migrate, delete, compact, or reclaim historical blobs. Reusing a generation—or
unsetting the variable to return to `models`—resumes writes to an existing core.
Production blind-peer reseeding is handled separately.
