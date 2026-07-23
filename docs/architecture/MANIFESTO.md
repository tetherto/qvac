# QVAC Architectural Manifesto

This document declares the non-negotiable architectural properties of QVAC systems. It answers: **what must always be true about how QVAC systems are built, and why?**

These properties are foundational architectural commitments — Independence & Disintermediation, Resilience, Data Sovereignty, and Locality — translated into constraints on every QVAC system. They do not prescribe solutions; that is the role of [Principles](PRINCIPLES.md) and Standards. They define the constraints within which all solutions must operate.

---

## 1. The device is sovereign

All core functionality executes on user-owned hardware. The device is not a thin client to a remote service; it is the system. Inference, data storage, model management, and user interaction all run locally as the default and primary mode of operation.

This follows from the physical reality that QVAC targets: autonomous cars don't ask the cloud for permission to brake, robots don't wait for a server response to catch a falling object, and users in disconnected environments can't depend on a datacenter thousands of kilometers away. Intelligence must be co-located with the entity that needs it.

*Derived from: Axiom 4 (Locality), Axiom 3 (Data Sovereignty)*

## 2. Network is enhancement, not dependency

Every QVAC capability must work without network connectivity. When network is available, it amplifies — P2P model sharing, delegated inference, cross-device sync — but its absence never degrades core function.

QVAC systems must operate in environments where connectivity is intermittent, expensive, censored, or nonexistent: disaster zones, deep-sea operations, rural clinics, air-gapped corporate networks, or simply a user on a plane. Progressive enhancement from network availability is welcome; graceful degradation to "no network" is not — because "no network" is the baseline, not the failure mode.

*Derived from: Axiom 2 (Resilience), Local-First Software ideal "network optional"*

## 3. No servers, only peers

QVAC's target state has no central servers in core paths. Devices connect directly to each other — for model distribution, inference delegation, and data sync. Central infrastructure may exist as a bootstrap mechanism to seed the network until it can self-sustain through peer redistribution, but it must never become a permanent dependency. The test is: if the central server disappears tomorrow, does the system continue to function for devices that have already participated?

Central servers are single points of failure, censorship targets, and trust assumptions. The QVAC ecosystem cannot depend on any entity — including Tether — remaining operational, cooperative, or uncensored for the system to function long-term. Centralized components are scaffolding: necessary during construction, removed once the structure stands on its own.

*Derived from: Axiom 1 (Independence & Disintermediation), requirement 1.A.1 "Elimination of central servers for core functionality"*

## 4. Data stays with its owner

User data is processed and stored on user-controlled devices. QVAC systems never transmit user data without explicit user action. Privacy is structural — enforced by architecture — not contractual — promised by policy.

Personal data — health records, conversations, documents, model interactions — is an extension of the self. Structural privacy means the system has no code path that silently transmits user data to external parties. Data leaves the device only when the user explicitly initiates it (e.g., sharing a diagnostic report, sending feedback) and can see what is being sent. The architecture must be auditable: anyone reading the code can verify that no silent exfiltration exists.

*Derived from: Axiom 3 (Data Sovereignty), "explicit verifiable logical trust"*

## 5. Run anywhere, from microcontrollers to servers

The architecture must accommodate the full spectrum of hardware: from constrained embedded devices to powerful workstations and dedicated inference servers. A single SDK, composable into what each target needs.

QVAC's vision spans light bulbs, wearables, phones, laptops, home hubs, industrial servers, and environments that don't yet exist. The architecture must be a set of composable building blocks — standardized, stackable — not a monolith that only runs on high-end hardware. What varies across the spectrum is capability and performance; what remains constant is the interface contract and the other properties in this manifesto.

*Derived from: composable building-block framing, target hardware spectrum from microcontrollers to servers*

## 6. Integrity of the core over speed of delivery

The properties in this manifesto are hard constraints, not aspirations to trade away under deadline pressure. If a feature cannot be built without compromising locality, privacy, resilience, or composability — it waits. Shortcuts that undermine the foundation compound across the entire ecosystem.

There is a fundamental difference between deliberate speed — focused, prioritized, intentional execution — and rushed work that accumulates structural debt. QVAC is building infrastructure for decades, not shipping features for quarters. Every shortcut on the foundation becomes a constraint on everything built above it, across every product in the ecosystem.

*Derived from: deliberate speed over rushed work*

## 7. Built for the long now

QVAC is infrastructure, not an application. Architectural choices prioritize longevity and adaptability over short-term convenience. The system must evolve with silicon and survive model format churn, runtime changes, and paradigm shifts in AI.

Model architectures will change. Hardware accelerators will evolve. Networking protocols will be replaced. The QVAC platform must outlast all of these. This means stable interface contracts (not stable implementations), strategic investment in the engine layer where it serves QVAC's unique needs, and avoiding tight coupling to external dependencies that could disappear or change direction.

*Derived from: long-horizon platform thinking, Local-First Software ideal "the Long Now"*
