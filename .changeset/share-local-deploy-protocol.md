---
---

Refactor: own the local deploy wire contract once in `packages/server/protocol.ts` and import it from the CLI, removing the duplicated request/response/status schemas. No user-facing behavior change.
