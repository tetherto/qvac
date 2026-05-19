# QVAC SDK v0.8.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.2

This is a maintenance release that refreshes the SDK README with a streamlined quickstart guide and updated documentation links pointing to the new docs site at docs.qvac.tether.io.

---

## 📘 Documentation

### README Rewrite

The SDK README has been rewritten to provide a cleaner onboarding experience. The verbose installation, usage, and feature sections have been replaced with a concise quickstart that gets users running in four steps, and all documentation links now point to the new docs site.

Key changes:

- **Simplified quickstart** — A minimal four-step guide (create workspace, install, write script, run) replaces the previous multi-section setup
- **Updated links** — Documentation URLs now point to `docs.qvac.tether.io` instead of `qvac.tether.dev`
- **Support channel** — The support link now points to the Discord channel instead of FeatureBase
- **Leaner content** — Detailed platform instructions (Expo, Linux), feature lists, and example indexes have been moved to the docs site to keep the README focused

---

## ⚙️ Infrastructure

- SDK dependency installs in CI publish and pod check workflows are now frozen to prevent unexpected version drift during builds.
