# 💥 Breaking Changes v0.2.0

## Harden serve CORS and managed authentication

PR: [#3744](https://github.com/tetherto/qvac/pull/3744)

**AFTER:**

```bash
# Run once per existing install, before starting the local QVAC service again.
openclaw onboard --auth-choice qvac
```

- Existing installs must rerun `openclaw onboard --auth-choice qvac` to materialize the private key file and the `--api-key-file` argument that onboarding persists in `openclaw.json`. Until then the local QVAC service fails with `--api-key-file requires a value …`; the launcher will not fall back to an unauthenticated serve.
- A key file that is not a regular file, or that is readable beyond its owner, now stops the launcher. The check runs on every read rather than only at onboarding. Recover with `chmod 600` on the file, or by re-running onboarding.

---
