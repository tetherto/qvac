// What `@qvac/sdk` resolves to inside the catalog (see tsconfig.json): nothing. The
// catalog is shared by every client, so a type it needs from the SDK belongs in
// wire-types.ts, where `check:contract` holds it to the wire contract.
export {}
