# QVAC OpenClaw Plugin v0.3.1 Release Notes

Release Date: 2026-09-07

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.3.1

A patch for a key-generation defect that made roughly one onboarding in 64 fail. No configuration or dependency changes.

## Onboarding No Longer Generates an Unusable Key

The plugin generates its bearer key as 32 random bytes encoded base64url. That alphabet includes `-`, and the plugin's own validator refuses a key beginning with `-` so that a stored key can never be mistaken for a command-line flag. The generator did not exclude that case, so about 1.5% of freshly generated keys were rejected the moment the launcher read them back:

```
stored QVAC API key must be 32-128 base64url characters and cannot start with "-"
```

The effect was a provider entry that onboarded cleanly and then refused to start, with a message describing the key file rather than the generator that wrote it. Re-running onboarding usually cleared it, because the replacement was a fresh draw with the same odds of being valid.

Key generation now draws again whenever a candidate starts with `-`, so every generated key satisfies the validator. Drawing again rather than rewriting the first character keeps all 43 positions uniform instead of biasing the first one.

The same generator backs the recovery path for a stored key that no longer parses, so that path could previously replace an unusable key with another unusable key. It is fixed by the same change.

## Upgrading

Nothing to do beyond installing the patch. An existing key file that already works is untouched, and one that was written in the broken form is replaced on the next onboarding run — now with a key that validates.
