# VLM benchmark fixture images

The benchmark's test images live here. **The image files are NOT in git** 
They are stored in a private S3 bucket and must be present locally
before the benchmark can run locally (copy images manually from the bucket)

For `run-local.cjs`, `--sync-fixture` fetches them with `aws s3 sync` when you have
bucket access, and `--fixture-dir <dir>` points at a copy kept elsewhere (see `../LOCAL.md`).
