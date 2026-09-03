# Default extension

The QVAC surface, mounted by `qvac serve` unless `--no-default` is passed. Its routes live
under `/qvac/v1`.

Server-wide behavior — authentication, CORS, model loading and `serve.models` — is
described in [README.md](README.md) and applies here. Its own configuration lives under
`serve.default`.

## Endpoints

The extension mounts no routes. A server with only this extension serves the shared
introspection routes: `/openapi.json`, and `/docs` with `--docs`.
