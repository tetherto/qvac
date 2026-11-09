---
name: qv-docs-scaffold
description: >-
  Creates the documentation of an internal package for Ecosystem → Packages:
  its versions file, the pages its kind requires from the scaffolds, its
  generated API reference, and its bindings. Use when invoking
  /qv-docs-scaffold.
disable-model-invocation: true
---

# Docs Scaffold

A package the products are built on — an addon, an engine, a library — is documented in its own `docs/users/` folder and listed under Ecosystem → Packages once a release pins its first line. This skill creates that documentation, conforming to the docs contract, so the developer judges only whether the content is complete and correct.

Run it once per package. To update documentation that exists, use `/qv-docs-update`.

## Inputs

Ask the developer for what the repository does not state:

- the package directory, `packages/<name>`;
- the product that is the canonical way to use the package's capability (`/sdk`, `/cli`, or another product's path from `docs/website/versions/`);
- one sentence on what the package does.

Read the rest from the package: its `package.json` name, its public declarations (`types`, else `index.d.ts`), its README.

## Steps

1. Refuse if `packages/<name>/docs/users/` already exists, or if `docs/website/versions/<name>.json` already exists. Point at `/qv-docs-update` instead.

2. Create `docs/website/versions/<name>.json`. A package not released yet declares no line; the pin-update workflow declares its first line at its first release.

   ```json
   {
     "package": "<package.json name>",
     "kind": "platform",
     "path": "/ecosystem/packages/<name>",
     "paths": ["packages/<name>/docs/users"],
     "lines": []
   }
   ```

   Add any other folder the pages import from (`packages/<name>/examples`) to `paths`, after the documentation root.

   Register the file in `docs/website/src/lib/versions.ts`: one `import` and one entry in `VERSIONS_FILES`. The manifest is bundled into client code, so it cannot read the folder at run time; `tests/versions-file.test.ts` fails when a file under `versions/` is not registered.

3. Copy every file of `docs/website/contract/scaffolds/platform/` into `packages/<name>/docs/users/`. They are the pages `docs/website/contract/kinds.json` requires of a `platform` package, except the API reference, which step 5 generates.

4. Fill every `{{…}}` placeholder from the package's README and declarations:
   - `{{name}}` is the directory name, `{{package}}` the published name, `{{slug}}` the directory name.
   - The overview names and links the canonical product. The contract check fails an overview that links none.
   - State only what the package's source, README, or tests support. Leave a placeholder you cannot ground, and list it in the report.
   - Follow [`qv-docs-update`'s editorial guidelines](../qv-docs-update/references/editorial-guidelines.md): facts the API reference renders are never repeated as prose.

5. Generate the API reference, where the package's dependencies are installed. It writes `_generated/api.json` and `api.mdx`.

   ```bash
   cd docs/website
   npm run docs:api -- packages/<name>
   ```

6. Record the bindings. Every usage page binds the whole surface, `binds: [surface]`, which the scaffold already declares. Add `surface` to any other page you wrote that explains the API.

   ```bash
   npm run docs:lock -- ecosystem/packages/<name>
   ```

7. Check the contract, the bindings, and the freshness of the API data.

   ```bash
   npm run docs:contract -- ecosystem/packages/<name>
   npm run docs:bindings -- ecosystem/packages/<name>
   npm run docs:api -- packages/<name> --check
   npm test
   ```

8. Report the files created, the placeholders left, and the icon or wording that needs the documentation owner's confirmation.

## Notes

- The package appears on the site only after its first release pins a line. Until then, review its pages in the pull request.
- Its newest line is served at `/ecosystem/packages/<name>/`, every other line under `/ecosystem/packages/<name>/v<major>.<minor>/`, and the switcher moves between them like a collection's lines.
- Never edit the package's source. Never write `_generated/`, `api.mdx`, or the lock by hand.
