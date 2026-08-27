# @qvac/bare-sdk

> **Deprecated.** `@qvac/bare-sdk` is discontinued. Use [`@qvac/inference`](../inference) for in-process Bare. Last release is **0.18.2**. There will not be a 0.19.0 of this package.

> *Part of **QVAC** ecosystem*
>
> [Home](https://qvac.tether.io/)  • 
> [Docs](https://docs.qvac.tether.io/)  • 
> [Support](https://discord.com/channels/1425125849346216029/1445400675189264516)  • 
> [Discord](https://discord.com/invite/tetherdev)

## Migrate to `@qvac/inference`

`@qvac/inference` is the Bare-only in-process engine. Plugin subpaths match 1:1 except `./commands` and `./worker-core`, which have no inference equivalent (`npx qvac bundle` lives on `@qvac/sdk`).

```diff
-import { plugins } from "@qvac/bare-sdk";
-import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";
+import { plugins } from "@qvac/inference";
+import { nmtPlugin } from "@qvac/inference/nmtcpp-translation/plugin";
```

```diff
-"@qvac/bare-sdk": "^0.18.2",
+"@qvac/inference": "^0.18.2",
```

See the [`@qvac/inference` README](../inference/README.md) for install, plugin assembly, and the capability-to-addon table.

Use `@qvac/sdk` for Node, Electron, and Expo apps that want the default worker over RPC.

## Release history

Historical notes live in the [`@qvac/sdk` changelog](../sdk/CHANGELOG.md). New Bare engine releases are documented in the [`@qvac/inference` changelog](../inference/CHANGELOG.md).
