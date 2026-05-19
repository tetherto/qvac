# QVAC Architectural Principles

These are decision-making rules for QVAC engineers. Each is traceable to the [Architectural Manifesto](MANIFESTO.md) and grounded in codebase evidence. They exist to help someone choose between two reasonable design options.

Principles are not aspirational platitudes. If a principle doesn't help resolve a real design disagreement, it doesn't belong here.

| # | Principle | One-line statement |
|---|-----------|-------------------|
| 1 | Device-First Design | Every feature must work fully on-device before considering network enhancement |
| 2 | Cross-Platform Parity | A capability on one platform must work on all supported platforms |
| 3 | Modular at the Interface, Pragmatic at the Boundary | Modularity lives in contracts and excludability, not in repo count or package granularity |
| 4 | P2P as Infrastructure | Use peer-to-peer networks for distribution, sync, and compute -- not centralized infra |
| 5 | Verifiable Trust Boundaries | Every trust boundary is enforced cryptographically where feasible, structurally where not — never by policy alone |
| 6 | Developer Experience is Architecture | DX is determined by API shape, extension symmetry, and error structure — not by docs |
| 7 | Observable Without Phoning Home | Rich local diagnostics; zero telemetry |
| 8 | Resilient at the SDK Boundary | The SDK client survives any worker/addon failure; apps don't solve crash recovery themselves |
| 9 | Reach Every Device That Matters | Optimize for the constrained end of the spectrum, not the powerful end |
| 10 | Inference Platform, Not Application Framework | The SDK solves inference and distribution; it does not own app state, storage, or identity |
| 11 | Strategic Depth Over Wholesale Forking | Go deep on the engine where it serves the manifesto; integrate where upstream covers the need |

---

## 1. Device-First Design

**Statement:** Every feature must work fully on-device before considering network enhancement.

**Rationale:** QVAC runs on user hardware in environments where network may be absent, unreliable, or hostile. The on-device path is not a fallback — it is the primary mode. Network capabilities (delegated inference, P2P model sharing, cross-device sync) are enhancements layered on top of a complete local experience.

**Manifesto trace:** The device is sovereign, Network is enhancement not dependency.

**Trade-off:** Some features will launch with lower capability ceilings than cloud-first competitors. A local LLM on a phone will not match a datacenter-hosted frontier model. We accept this because the baseline must always work without network, and progressive enhancement adds network capability where available.

**Implications:**
- Distinguish **provisioning** (one-time: getting assets onto the device) from **runtime operation** (ongoing: using those assets). Runtime must be fully offline. Provisioning may use network but must also have offline paths (local file sideloading, nearby peer transfer, pre-installed on hardware).
- Model download is provisioning — it uses the network once, and after that inference is fully local. This does not violate device-first: the model is an asset that lives on the device permanently once acquired, like installing an application.
- Every SDK runtime API (inference, RAG, config, model management) must work with zero network access once models are provisioned.
- Tests must include offline scenarios as first-class cases, not edge cases.
- Design reviews should ask: "Once provisioned, does this work if we pull the network cable?"

**What this does NOT mean:**
- It does NOT mean models must appear on the device by magic. Network-based model download (P2P or HTTP) is expected for initial provisioning. The principle requires that after provisioning, the device operates independently.
- It does NOT mean we avoid network features. Delegated inference, P2P model distribution, and cross-device sync are valuable and encouraged — as enhancements.
- It does NOT mean every device runs every capability. A microcontroller runs a different subset than a workstation. But what each device does run, it runs locally.

---

## 2. Cross-Platform Parity

**Statement:** A capability available on one platform must work on all supported platforms.

**Rationale:** QVAC targets phones, laptops, desktops, and embedded devices across multiple operating systems. Platform fragmentation creates second-class user experiences and fractures the developer ecosystem. When a capability is only available on macOS or only on desktop, it undermines the "run anywhere" promise and forces app developers to write platform-specific workarounds.

**Manifesto trace:** Run anywhere from microcontrollers to servers.

**Trade-off:** We will sometimes choose a less mature but cross-platform library over a more capable platform-specific one. HyperDB was chosen for RAG over LanceDB (desktop-only). Bare was chosen over Node.js because Node has no mobile story. This may mean giving up some performance or features available in platform-specific alternatives.

**Implications:**
- New inference addons must ship prebuilds for the full platform support matrix (darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, Android, iOS).
- Library choices must be evaluated for cross-platform viability before adoption, not after.
- A feature that works on desktop but not on mobile is incomplete, not shipped.
- When platform constraints make parity impossible (e.g., GPU acceleration on a specific backend), document the gap explicitly rather than silently degrading.

**What this does NOT mean:**
- It does NOT mean identical performance on all hardware. A phone will be slower than a workstation. Parity means the API works and produces correct results, not that it runs at the same speed.
- It does NOT mean every platform gets every model. Hardware constraints determine which models fit; the SDK surface remains consistent.

---

## 3. Modular at the Interface, Pragmatic at the Boundary

**Statement:** Modularity lives in contracts and excludability, not in repository count or package granularity.

**Rationale:** QVAC must be composable — a wearable bundles different capabilities than a desktop assistant. This requires clean interfaces between components so that each can be included or excluded independently. But modularity is an interface property, not a deployment property. The project initially split every component into its own repository; the operational overhead (CI fragmentation, cross-repo version management, broken dependency chains) outweighed the theoretical purity. A monorepo with strict plugin and addon contracts is more modular than fifty repos with tangled dependencies.

**Manifesto trace:** Run anywhere (compose what each target needs), Built for the long now (capabilities evolve independently).

**Trade-off:** Monorepo structure means all packages share a single CI and review process, which can slow down changes that only affect one package. The plugin contract imposes constraints on addon authors (Bare compatibility, static imports for tree-shaking). These costs are lower than the alternative: per-repo version hell and broken cross-package integration.

**Implications:**
- Every inference capability is a plugin implementing the `QvacPlugin` interface. Built-in and third-party plugins share the identical contract.
- The addon binary interface (`BaseInferenceArgs.addon`) is the boundary between JavaScript orchestration and native C++ inference. It must remain stable.
- `bare-pack` tree-shaking determines what ships in a bundle. Capabilities not imported are not included. This is the mechanism that makes "compose what you need" practical.
- New capabilities must be designed as plugins from day one, not bolted onto the core and extracted later.
- Physical package boundaries (what gets its own `package.json`) are driven by publish/version lifecycle needs, not by an ideological desire for small packages.

**What this does NOT mean:**
- It does NOT mean everything in one giant package. Packages that have independent version lifecycles, different native build requirements, or separate consumer audiences should be separate packages.
- It does NOT mean modularity is optional. The plugin contract is mandatory for all inference capabilities. "Pragmatic at the boundary" governs how packages are organized, not whether interfaces are clean.

---

## 4. P2P as Infrastructure

**Statement:** Use peer-to-peer networks for distribution, sync, and compute — not centralized infrastructure.

**Rationale:** QVAC's architecture rejects central servers in core paths. P2P is not a feature layered on top; it is the infrastructure layer. Model distribution uses Hyperswarm/Hyperdrive, not a CDN. The model registry uses HyperDB, not a centralized database. Delegated inference routes through Hyperswarm topic-based discovery, not a load balancer. This makes the infrastructure censorship-resistant, scales with the number of participating devices, and has no single point of failure.

**Manifesto trace:** No servers, only peers.

**Trade-off:** P2P introduces latency variance, NAT traversal complexity, and discovery time that centralized infrastructure doesn't have. Initial model downloads may be slower than a CDN when few peers are available. Debugging distributed systems is harder than debugging client-server. These costs are accepted because centralized infrastructure contradicts the manifesto.

**Implications:**
- Model distribution, registry, and delegated inference must use Holepunch (Hyperswarm, Hyperdrive, HyperDB) as the primary path.
- HTTP model download exists as a developer convenience and enterprise accommodation, not as the default or recommended path.
- New features that require coordination between devices must use P2P, not introduce a central server.
- Connection setup, relay configuration, and peer discovery must be handled by the SDK transparently — developers should not need to understand DHT mechanics to use `loadModel()`.

**What this does NOT mean:**
- It does NOT mean every feature must use P2P. Features that are purely on-device (local inference, local RAG, config loading) have no need for any network layer.
- It does NOT mean HTTP is forbidden. HTTP is available as a secondary model source for environments where P2P is impractical (corporate firewalls, CI pipelines, development setups). It is not the default.

---

## 5. Verifiable Trust Boundaries

**Statement:** Every trust boundary enforces its security properties through cryptography, isolation, or sandboxing — never through policy, review, or assumed-good-actors. Where cryptographic verification is technically feasible, it is required, not optional. Where it is not feasible (in-process calls, hardware-rooted attestation gaps), the boundary must be documented and the gap tracked as debt.

**Rationale:** QVAC handles intimate user data: health records, personal conversations, documents, credentials for device automation. "We promise not to look" is not a security model, and neither is "we reviewed the code." The only durable assurances are mechanical: cryptographic proof, process isolation, hardware sandboxing. Every boundary that data crosses — P2P transport, plugin execution, delegated inference, cross-device sync, local IPC — must have an enforcement mechanism a third party can verify, not a policy a maintainer can forget.

**Manifesto trace:** Data stays with its owner, Integrity of the core, No servers only peers.

**Trade-off:** Structural security adds implementation complexity and may impact performance (encryption overhead, sandbox startup time). It requires upfront design work for every new boundary rather than a quick "trust the local process" shortcut. Current gaps in the codebase (no at-rest encryption, no local API authentication) are technical debt to close, not design choices to preserve.

**Implications:**
- P2P transport uses Noise protocol encryption. This is non-negotiable.
- Model integrity is verified via SHA256 checksums on download. This is non-negotiable.
- Skill/plugin execution must be sandboxed (container isolation on desktop, platform sandboxing on mobile). This is actively being built.
- Every new boundary (new RPC channel, new data sync path, new addon interface) must document its security properties before merging.
- "Trusted local process" assumptions in existing code should be progressively replaced with explicit authentication and authorization as the system matures.

**What this does NOT mean:**
- It does NOT mean every line of code needs a security review. Internal function calls within a single process don't cross trust boundaries.
- It does NOT mean security blocks shipping. New features ship with security at their boundaries; existing debt is closed incrementally. But new boundaries must be secure from day one.

---

## 6. Developer Experience is Architecture

**Statement:** The SDK has two classes of consumer — app developers and plugin authors — and their experience is determined by architectural decisions, not by documentation and examples alone.

**Rationale:** The architecture is the developer experience as far as a consumer is concerned: API shape, extension symmetry, error structure, runtime portability. Documentation and examples can drive initial adoption despite weak architecture, but cannot prevent displacement once a better-architected competitor with comparable docs appears. DX is a downstream signal of architectural choices over the project's lifetime, not a target reachable by writing more examples.

**Manifesto trace:** Run anywhere (ecosystem growth depends on adoption), Built for the long now (stable contracts outlast docs).

**Trade-off:** Architectural DX imposes a permanent velocity tax on the core team — they cannot take shortcuts that plugin authors can't take. Symmetric contracts forbid privileged hooks for built-ins; stable public surfaces require versioned migrations; runtime portability means the SDK absorbs runtime-specific complexity rather than exposing it. The cost is paid continuously, not once.

**Implications:**
- Built-in and third-party plugins use the identical `QvacPlugin` interface. No privileged core-only hooks.
- The public API surface is an explicit allowlist; breaking changes are versioned with migration paths.
- Runtime differences (Node, Bare, Bun, Expo) are absorbed by the SDK. App developers do not branch on runtime.
- Errors are part of the contract: documented codes, preserved cause chains across RPC, recoverable vs terminal distinction.
- Streaming and cancellation are uniform primitives — same async-iterator + `cancel()` shape across capabilities.
- Plugin authors get the same diagnostic infrastructure (`loggingStream`, profiler, error registry) as the core team.
- OpenAI-compatible REST is architectural alignment with a known contract, not a courtesy.
- Examples and getting-started guides are part of the definition of done. They close the residual gap.

**What this does NOT mean:**
- It does NOT mean dumbing down the platform. Advanced users and plugin authors need access to lower-level APIs. The common path is easy; the advanced path remains available.
- It does NOT mean API stability prevents evolution. Public APIs change — deliberately, versioned, and communicated.
- It does NOT mean addon authors are a covered consumer class. The principle covers app developers and plugin authors; addon-author DX is out of scope until third-party addon authoring becomes a stated goal.

---

## 7. Observable Without Phoning Home

**Statement:** Provide rich local diagnostics — logging, profiling, structured error codes — but never transmit telemetry or analytics to any external service.

**Rationale:** QVAC has no in-app analytics by design. This is a direct consequence of the privacy manifesto property. But the absence of telemetry cannot mean the absence of observability. Engineers debugging issues on user hardware — hardware they've never seen and can't access — need structured logs, meaningful error codes, and profiling data that users can share voluntarily.

**Manifesto trace:** Data stays with its owner, Integrity of the core.

**Trade-off:** Without server-side telemetry, we cannot measure usage patterns at scale, detect regressions via error rate dashboards, or run A/B tests. Quality signal comes from app store metrics (crash-free rate, ratings), community surveys (NPS), local profiler output shared by users, and direct support interactions. This is slower and noisier than centralized analytics.

**Implications:**
- The SDK provides three-boundary logging (client, RPC, worker) with a `loggingStream` API for apps to consume.
- Errors use numeric codes with distinct client and server ranges, and preserve cause chains across the RPC boundary.
- The built-in performance profiler surfaces request-time bottlenecks across platforms without sending data anywhere.
- No code path — not even an opt-in one — transmits usage data to Tether or any third party. Diagnostic data is produced locally and stays local unless the user explicitly shares it.

**What this does NOT mean:**
- It does NOT mean we ignore quality signals. We actively measure quality through crash-free rates, store ratings, NPS surveys, and community feedback channels.
- It does NOT mean diagnostics are an afterthought. Local observability must be good enough that an engineer can diagnose a problem from a user-shared log without reproducing it locally.

---

## 8. Resilient at the SDK Boundary

**Statement:** The SDK client process must survive any failure in the worker or native addon layer. Crashes are contained, errors are structured, and the SDK returns to a usable state — so that 1000+ apps don't each have to solve crash recovery themselves.

**Rationale:** The SDK has a natural crash boundary: the client process (in the app's address space) communicates over IPC with a separate worker process that hosts native C++ inference addons. Native addons can and will crash — OOM, segfaults, corrupted memory from C++ buffer overflows. When a native addon corrupts process memory, no recovery code running inside that process can be trusted. The only reliable response is to terminate the worker and start a fresh one. In-flight state (KV cache, partial inference results) is lost, but the client process — and the app — stays alive. If the SDK didn't absorb this complexity at its boundary, every app developer would have to build their own crash detection, health monitoring, and worker restart logic. That's a shared-infrastructure problem the SDK should solve once.

**Manifesto trace:** The device is sovereign (no external recovery path), Integrity of the core (reliability is non-negotiable), Run anywhere (constrained devices hit resource limits more often).

**Trade-off:** Crash isolation and worker supervision add implementation complexity. Worker restart incurs latency (process startup, model re-load). Fast-fail on bad input means some edge cases that "might have worked" will be rejected early. These costs are lower than pushing crash recovery to every app built on the SDK.

**Implications:**
- The client/worker process boundary is the critical isolation line. A native addon crash (OOM, segfault) must never propagate to the client process. The client must detect worker failure and return a structured error to the caller.
- The SDK does not checkpoint application-level state. In-flight state (KV cache, partial inference) lives in worker memory and is lost on crash. Worker recovery means: start a new process, re-load the model, ready. The cost of losing in-flight state is accepted because the alternative — trying to recover from corrupted process memory — is unreliable.
- Every failure mode must have a defined behavior: interrupted downloads resume or clean up (never leave corrupt partial state), bad model files are detected and rejected at load time, resource exhaustion triggers graceful unloading before the OS kills the process.
- Cancel semantics must be complete: `cancel()` on any in-flight operation (inference, download, RAG ingest) must release resources and return the system to a clean state.
- Error codes must distinguish recoverable failures (retry makes sense) from terminal failures (model incompatible with hardware) so the calling app can respond appropriately.

**What this does NOT mean:**
- It does NOT mean the SDK guarantees the *application* never crashes. The SDK controls its own boundary. What the app does with SDK errors is the app's responsibility.
- It does NOT mean errors are silenced. Every failure is surfaced with a structured error code and actionable message. Resilience means surviving the failure and reporting it clearly, not hiding it.
- It does NOT mean infinite retries. Some failures are terminal (model too large for device memory, unsupported hardware). The principle requires clear communication, not magical recovery from impossible conditions.

---

## 9. Reach Every Device That Matters

**Statement:** Optimize for the constrained end of the device spectrum, not the powerful end. If it runs well on a 3-year-old phone with 8GB RAM, it will run great everywhere else.

**Rationale:** QVAC's vision extends to rural clinics, users in developing regions, and older consumer hardware — not just flagship phones and developer workstations. Resource efficiency (memory footprint, binary size, startup time, battery impact) is a design constraint, not a polish step. A system that only runs on the latest Samsung S25 excludes most of the world. Targeting the constrained end forces efficiency that benefits all devices, while targeting the powerful end produces bloat that excludes the very users the manifesto is meant to serve.

**Manifesto trace:** Run anywhere from microcontrollers to servers, The device is sovereign (the device must be capable enough to actually be sovereign).

**Trade-off:** Targeting constrained devices limits which dependencies, abstractions, and features are acceptable. A convenient 10MB JavaScript dependency that barely registers on a workstation may be disqualifying on a phone with limited storage. Aggressive quantization that fits a model in 4GB RAM may sacrifice quality that a desktop user would prefer to keep. The principle requires tiered optimization rather than one-size-fits-all — but the floor must be low enough to matter.

**Implications:**
- Binary size, memory footprint, and startup time must be tracked in CI. Regressions on constrained device profiles are blocking, not advisory.
- Model profiles must be tiered by device capability (low/medium/high device tiers). The SDK must make it easy to select the right model for the hardware, not just the best model overall.
- New dependencies must justify their weight. A library that adds 5MB to the bundle needs a strong case; a 50KB alternative that covers 90% of the use case is preferred.
- Tree-shaking via `bare-pack` is not just a nice-to-have — it is the mechanism that keeps bundles viable on constrained devices. Capabilities not used must add zero weight.
- Inference that produces sequential output (LLM token generation, transcription segments, TTS audio frames, translation segments) must deliver results progressively. On constrained devices, unary delivery of multi-second generative inference is not viable UX — streaming is a consequence of targeting the constrained end of the spectrum, not an independent concern. Atomic outputs (embedding vectors, classifier scores, language detection) return a single result.
- "Works on a 3-year-old mid-range Android phone" is a practical litmus test for whether a feature is ready to ship on mobile.

**What this does NOT mean:**
- It does NOT mean all devices get the same experience. A workstation runs larger models and faster inference. The principle requires that *something useful* runs on constrained devices, not that the experience is identical.
- It does NOT mean we avoid powerful features. GPU-accelerated inference, large multimodal models, and distributed computation are valuable. The principle requires that these are progressive enhancements, not baseline requirements.
- It does NOT mean we support every device ever made. "Reasonable extent" means defining a support floor (e.g., minimum RAM, minimum OS version) and being explicit about it.

---

## 10. Inference Platform, Not Application Framework

**Statement:** The SDK solves AI inference, model management, and P2P distribution. It deliberately does not own application state, storage, user identity, or UI. Each of those is a separate layer that apps or separate SDKs choose independently.

**Rationale:** SDK products fail when they grow into application frameworks through scope creep. Every "convenient" addition — a built-in database, a state management layer, a user identity system — becomes a dependency that constrains the apps built on top. QVAC's SDK is intentionally stateless and storage-agnostic. It does not dictate how apps persist data, manage sessions, or handle user identity. This keeps the SDK focused on the problem it solves uniquely (local AI inference + P2P distribution), keeps its footprint small (critical for constrained devices), and gives app developers freedom to compose it with whatever storage, state, and identity layers fit their use case. If P2P storage or sync becomes a need, that's a separate SDK with its own scope — not bolted onto the inference SDK.

**Manifesto trace:** Run anywhere (small footprint by not bundling unnecessary layers), Built for the long now (focused scope survives longer than swiss-army-knife frameworks), Integrity of the core (solve one problem deeply rather than many problems shallowly).

**Trade-off:** App developers must bring their own storage and state management. There's no "batteries-included" experience for building a complete application with just `@qvac/sdk`. This increases initial setup effort for app developers but avoids locking them into storage choices that may not fit their platform, scale, or privacy requirements.

**Implications:**
- The SDK manages only its own operational state: model cache, config, RAG workspaces. It does not persist application-level data.
- No checkpointing of inference sessions or application state. Worker crash recovery is simple precisely because there's no state to reconcile — restart the worker, re-load the model, ready.
- Features that require application-level persistence (conversation history, user preferences, document storage) are the app's responsibility, not the SDK's.
- If a feature proposal adds a storage layer, an identity system, or a UI component to the SDK, the default answer is "that belongs in a separate package or in the app."
- The Holepunch stack (Hyperswarm, Hyperdrive, HyperDB) provides P2P primitives that apps can use directly for sync and storage — the SDK uses them for model distribution but does not re-export them as a general-purpose storage API.

**What this does NOT mean:**
- It does NOT mean the SDK is unhelpful. The SDK provides everything needed for AI inference, model management, and P2P model distribution. It's a complete solution for its scope.
- It does NOT mean apps can't use Holepunch for storage. Apps can and should use Hyperswarm, Hyperdrive, and HyperDB directly when they need P2P storage or sync. The SDK just doesn't wrap or re-export those as its own feature.
- It does NOT mean the scope never expands. If a capability is needed by the vast majority of SDK consumers and fits the inference/distribution scope, it can be added. But the burden of proof is on inclusion, not exclusion.

---

## 11. Strategic Depth Over Wholesale Forking

**Statement:** Invest deeply in the inference engine where it creates value that serves the manifesto and that upstream won't provide. Integrate where upstream covers the need. Never fork for the sake of control.

**Rationale:** QVAC's engine layer (qvac-fabric) is not a thin wrapper — it contains real capabilities upstream doesn't offer: on-device fine-tuning, cross-platform optimizations for constrained hardware, and potentially a unified inference runtime across model types. These investments are strategically correct because they directly serve manifesto properties (device sovereignty, run anywhere) that upstream projects don't prioritize. But not every divergence from upstream is strategic. New model architecture support, standard quantization methods, and commodity inference paths are things upstream llama.cpp's thousands of contributors handle well. Duplicating that work is waste. The principle provides a decision framework: go deep where depth serves the manifesto, integrate where upstream covers the need, and always track the cost of divergence.

**Manifesto trace:** Built for the long now (the engine must evolve with silicon), The device is sovereign (on-device fine-tuning, constrained-device optimization), Run anywhere (unified runtime across model types).

**Trade-off:** Deep engine investment competes for engineering time with SDK and platform work. Every custom feature that diverges from upstream makes merging harder — and upstream moves fast. The risk is that accumulated divergence eventually makes merges so painful that the fork becomes a separate project, cutting QVAC off from upstream improvements. This must be managed explicitly, not ignored.

**Implications:**
- Before adding a feature to the engine layer, ask: **"Does this serve a manifesto property that upstream won't address?"** On-device fine-tuning, microcontroller support, unified ggml runtime → yes, invest. New model architecture that upstream will support in weeks → no, integrate.
- Upstream merges remain a priority. Continuous merging from upstream is the target. Custom features must be structured to minimize merge conflicts — isolated modules, clean boundaries, not scattered patches across upstream code.
- Features that could benefit upstream should be contributed back where possible. Reducing divergence reduces maintenance burden.
- The eval suite benchmarks both model quality and engine integration performance so regressions from upstream merges or custom features are caught immediately.
- Divergence from upstream must be tracked explicitly. If merge difficulty is increasing over time, that is a signal to re-evaluate which custom features are worth their maintenance cost.

**What this does NOT mean:**
- It does NOT mean being a thin wrapper. The engine layer has real strategic value and the team's deep investment in it is the right call for capabilities upstream won't provide.
- It does NOT mean forking freely. Every divergence has a maintenance cost. "Strategic" means the value to the manifesto justifies that cost, not that any interesting feature justifies it.
- It does NOT mean upstream merges can slip indefinitely. Even with significant custom features, staying current with upstream model support and performance improvements is essential for the platform's long-term viability.

---

## References

Foundational documents and external works that shaped these principles.

**Internal**
- [QVAC Architectural Manifesto](MANIFESTO.md) — The non-negotiable properties these principles derive from

**External**
- [Local-First Software](https://www.inkandswitch.com/essay/local-first/) (Kleppmann et al., 2019) — Seven ideals for software where the device is primary. Directly relevant: QVAC is local-first AI inference. Ideals include "no spinners," "network is optional," "data ownership," and "the Long Now."
- [Reactive Manifesto](https://www.reactivemanifesto.org/) (Bonér et al., 2014) — Four properties: responsive, resilient, elastic, message-driven. Relevant to SDK internals: streaming APIs, addon isolation, failure handling.
- [Reactive Principles](https://www.reactiveprinciples.org/principles/index.html) (Bonér et al., 2022) — Eight principles derived from the Reactive Manifesto. Good structural model: manifesto → principles → patterns.
- [Edge Native](https://www.reactiveprinciples.org/edge-native/index.html) — "The function of individual devices must not hinge upon the reachability of central components." Directly relevant to QVAC's runtime model.
- [REA Group — 8 Architectural Principles](https://www.rea-group.com/about-us/news-and-insights/blog/scaling-technology-with-architectural-principles/) — Format model for principle structure (statement, rationale, implications).
- [TOGAF Principle Catalog](https://www.opengroup.org/architecture/togaf7-doc/arch/p4/princ/princ.htm) — The "Implications" section format (what must change to support this principle).
