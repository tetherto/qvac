# Security Policy

- [**Security considerations**](#security-considerations)
  - [Native addons and prebuilt binaries](#native-addons-and-prebuilt-binaries)
  - [Model registry and model artifacts](#model-registry-and-model-artifacts)
  - [Supply chain and CI/CD](#supply-chain-and-cicd)
  - [P2P and network exposure](#p2p-and-network-exposure)
- [**Supported versions**](#supported-versions)
- [**Reporting a vulnerability**](#reporting-a-vulnerability)

## Security Considerations

QVAC is a monorepo containing native C++ addons, a TypeScript SDK, a distributed model registry, CLI tooling, and P2P data loaders. Each package type carries distinct security considerations.

### Native addons and prebuilt binaries

QVAC ships prebuilt native binaries for multiple platforms. When consuming these packages:

* **Verify package integrity:** Packages published to npm (`@qvac`) and GitHub Packages (`@tetherto`) are built in CI from pinned toolchains. Confirm you are installing from these official scopes.
* **Pinned native dependencies:** All C++ dependencies are managed through vcpkg with locked versions and a private registry (`qvac-registry-vcpkg`). Ad-hoc or unvetted native libraries are not used.
* **Sandboxing inference:** If running inference on untrusted model files, isolate the process (containers, VMs, or OS-level sandboxing). Malformed model files could exploit vulnerabilities in parsing or runtime code.

### Model registry and model artifacts

The distributed model registry (`qvac-lib-registry-server`) manages model discovery and distribution.

* **Model provenance:** Always verify the source and hash of downloaded model artifacts before loading them into an inference addon.
* **Registry schema validation:** Model metadata is validated against a JSON schema. Do not bypass schema validation when adding or consuming registry entries.
* **License verification:** The registry enforces license-gated downloads via HuggingFace tokens. Do not circumvent these checks.

### Supply chain and CI/CD

* **Fork PR security:** All `pull_request_target` workflows require an authorization gate (`authorize-pr`) before secrets are exposed. Labels are stripped on new pushes from non-writers, forcing maintainer re-review.
* **Action pinning:** All GitHub Actions are pinned to SHA, not mutable tags.
* **Publish pipeline:** Publishing to npm requires merge to a `release-*` branch with a merge guard that validates version, changelog, and branch-name alignment. Manual `workflow_dispatch` bypasses the guard but requires repository write access.
* **Secret scoping:** Secrets are passed per-job, not inherited globally. CI artifacts never contain secrets or tokens.

### P2P and network exposure

QVAC supports P2P data loading via Hyperdrive and similar transports.

* **Do not expose P2P endpoints to untrusted networks** without authentication and encryption.
* **Encrypt data in transit** when operating outside a trusted local network.
* **Validate all data received** from peers before processing.

## Supported Versions

<!-- TODO: Dev team — update this table with currently supported versions -->

| Package | Supported Versions |
| ------- | ------------------ |
| `@qvac/*` | <!-- e.g. >= 1.0.0 --> TBD |

## Reporting a Vulnerability

If you have discovered a security vulnerability in this project, please report it privately. **Do not disclose it as a public issue.** This gives us time to work with you to fix the issue before public exposure, reducing the chance that the exploit will be used before a patch is released.

<!-- TODO: Dev team — uncomment ONE of the two reporting methods below -->

<!-- Option A: GitHub Security Advisories (recommended if repo is public) -->
<!-- Please disclose it as a private [security advisory](https://github.com/tetherto/qvac/security/advisories/new). -->

<!-- Option B: Email-based reporting -->
<!-- **Email:** security@tetherto.com -->
<!-- **Subject line:** `[SECURITY] Brief description of the vulnerability` -->

### What to Include

- Description of the vulnerability
- Steps to reproduce (or proof of concept)
- Affected package(s) and version(s)
- Impact assessment (what an attacker could achieve)

> [!NOTE]
> Using AI to identify vulnerabilities and generate reports is permitted. However, you must (1) explicitly disclose how AI was used and (2) conduct a thorough manual review before submitting the report.

### What to Expect

<!-- TODO: Dev team — adjust timelines to match your SLA -->

| Step | Timeline |
| ---- | -------- |
| Acknowledgement of report | Within **2 business days** |
| Initial triage and severity assessment | Within **5 business days** |
| Fix or mitigation plan communicated | Within **14 business days** |
| Patch released (critical/high severity) | Within **30 days** |
| Patch released (medium/low severity) | Within **90 days** |

A team maintains this project on a reasonable-effort basis. Please give us at least 90 days to work on a fix before public exposure.

### Disclosure Policy

- We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
- We will credit reporters in the release notes unless anonymity is requested.
- Please allow us reasonable time to address the issue before public disclosure.

## Scope

This policy covers the `qvac` monorepo and all packages published under `@qvac` (npm) and `@tetherto` (GitHub Packages), including:

- Native inference addons (`qvac-lib-infer-*`)
- TypeScript SDK (`qvac-sdk`)
- Model registry (`qvac-lib-registry-server`)
- CLI tooling (`qvac-cli`)
- Data loaders (`qvac-lib-dl-*`)
- Supporting libraries (`qvac-lib-error-base`, `qvac-lib-logging`, `qvac-lib-rag`, etc.)

Out of scope:
- Third-party dependencies (report upstream)
- Social engineering attacks against maintainers
- Denial of service against CI infrastructure

<!-- TODO: Dev team — review all placeholder sections above and fill in before open-sourcing -->
