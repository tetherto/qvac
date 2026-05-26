# @qvac/registry-client v0.6.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/registry-client/v/0.6.0

This release completes the registry hyperdb v6 cascade on the client side. It pulls in `@qvac/registry-schema@^0.3.0` (HyperDB 6) and simplifies the install graph by owning the Holepunch libraries the client imports directly. The public `QVACRegistryClient` API is unchanged.

---

## 🔧 Changed

### HyperDB 6 via updated schema dependency

`@qvac/registry-schema` is bumped from `^0.2.0` to `^0.3.0`, which brings HyperDB 6 transitively. The client no longer lists `hyperdb` as a peer — HyperDB is owned by the schema package.

### Dependency graph cleanup (#2254)

`corestore`, `hyperblobs`, and `hyperswarm` move back from `peerDependencies` to direct `dependencies` (only the packages the client actually imports). This aligns with the hyperdb v6 migration and avoids peer-range drift when installed alongside `@qvac/sdk`.
