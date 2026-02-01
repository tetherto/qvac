# Contributing to QVAC SDK

Welcome to the QVAC SDK! This document outlines our contribution guidelines designed to establish **high trust, high velocity, and high reliability** development practices.

## 🎯 Core principles

**The purpose of each contribution should be to solve a specific problem, not to add code to the SDK.**

Our aim should always be to **simplify, reduce, minimize**. Verbosity is our enemy. Every line of code is a liability - it must be maintained, debugged, understood, and potentially refactored.

**The best code is the code you don't write. The second best is the code you delete.**

If you manage to solve a problem by removing code, that gives you double points - it shows you actually understood what the problem and found the most optimal solution, which is always to delete code rather than add it.

**Code reduction** is often the most ignored metric, even though it's the best predictor of quality and lack of bugs.

**The worst error a smart engineer can make** is to optimize something that shouldn't exist.

**Sources:**

- [The Best Code is No Code At All](https://blog.codinghorror.com/the-best-code-is-no-code-at-all/) - Jeff Atwood
- [Question Every Requirement](https://www.youtube.com/watch?v=hhuaVsOAMFc) - On avoiding the trap of optimizing things that shouldn't exist
- [Code Reduction as Quality Predictor](https://www.youtube.com/watch?v=Rpaat8WFqxY) - Evidence that reducing code is the best predictor of codebase quality

## 💡 Contributing tips

### 🛡️ Tip 1: Never break user space

**Never change the exposed API unless we're adding something that improves the UX.**

This can be a simplification or an additional function that allows users to use new functionality. But we don't break the API just because we can't figure things out internally. We don't change the API just to solve an implementation problem.

### 🔬 Tip 2: Keep pull requests surgical and laser-focused

**Each PR should solve exactly one problem or implement exactly one feature.**

If you discover related issues while working, create separate PRs. Keep PRs small and reviewable.

Prefer isolating complexity in separate modules/folders rather than spreading potentially breaking changes across the codebase.

### 🔒 Tip 3: Strict type safety

**Zero tolerance for type safety violations.**

- Never use `any` on the client
- On the server, use type coercion only with common sense (Bare runtime has bad/non-existent type definitions)
- Never use `unknown` unless it's clearly necessary (e.g., RPC bridges where type coercion is required)
- Never use `@ts-ignore`, ESLint disable directives, or similar unless extremely necessary

### 🌐 Tip 4: No platform-specific code in the client

**The client is made to run on any platform that allows JavaScript.**

Any platform-specific functionality is done on Bare (server-side). The client should be essentially just an RPC client that can be ported to different languages. All logic requiring standard library or platform-specific features goes on the server.

### ✂️ Tip 5: Simplify, simplify, simplify

**When you're done implementing a feature or bug fix, always question whether you can do it in a simpler way.**

Use AI tools to review your implementation. Look for patterns that can be eliminated or merged. After implementing, always ask: "Can this be simpler?"

## 🔄 Development workflow

**Before Starting:** Understand the problem completely, plan your approach, open a draft PR with your implementation plan.

**During Development:** Write minimal code that solves the problem, maintain type safety, test with existing examples.

## ❓ Questions?

When in doubt: Look at existing code for patterns, ask AI tools for guidance on simplification, open a draft PR early for feedback, keep it simple.
