# Readar CLI architecture

The independent TypeScript / Node.js CLI communicates only through HTTP. `src/main.ts` owns argument validation and JSON output; `src/client.ts` owns authenticated requests and refresh rotation; `src/store.ts` owns restricted local session files and process locks.

`src/records.ts` delegates listings and details to the server’s global `/v1/questions` and `/v1/notes` routes, passing filters and wrapping the signed server cursor with an API/account/filter fingerprint. Version 1 scan cursors are rejected. Each listing page or detail uses one normal authenticated request; no episode traversal occurs. Authentication refresh, if necessary, adds its existing request.

The backend indexes changed questions and notes in Tablestore asynchronously. PostgreSQL remains the payload and authorization source. Search uses relevance order; listings without a query use descending creation/ID/episode order. The output carries `search_mode` and `consistency`. Search failures are propagated with stable errors rather than falling back to local scanning.

Collection and authentication continue to use existing Readar endpoints. This repository contains no cloud SDK, backend imports or database access. The initial repository has no remote or published registry package; distribution documentation distinguishes local installation from future registry installation.
